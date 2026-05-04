// 腾讯云 COS（对象存储）上传通道：把本地音频 PUT 到用户自己的 COS bucket，
// 再用预签名 GET URL 喂给 ASR `CreateRecTask` 走 SourceType=0 路径，绕开 base64
// 5MB 上限（COS 单文件 5GB；ASR 实际 ≤512MB）。
//
// 协议：
//   - PUT object：https://{bucket}.cos.{region}.myqcloud.com/{key}
//     鉴权 = COS Signature v5 (HMAC-SHA1)；放在 Authorization header。
//   - GET 预签名：query string 携带同样字段，给 ASR 服务跨账号下载用。
//
// 文档：https://cloud.tencent.com/document/product/436/7778
//
// 凭证复用 keyring 里的 SecretId / SecretKey（同 ASR）；bucket / region 从前端
// settings.json 透传。

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use hmac::{Hmac, Mac};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::time::Duration;

type HmacSha1 = Hmac<Sha1>;

#[derive(Debug, Clone)]
pub enum CosError {
    Unauthenticated(String),
    Forbidden(String),
    Network(String),
    Unknown(String),
}

impl CosError {
    #[allow(dead_code)] // 错误字符串路由由 Display 主导；code() 留给将来分流
    pub fn code(&self) -> &'static str {
        match self {
            CosError::Unauthenticated(_) => "tencent_cos_unauthenticated",
            CosError::Forbidden(_) => "tencent_cos_forbidden",
            CosError::Network(_) => "tencent_cos_network",
            CosError::Unknown(_) => "tencent_cos_unknown",
        }
    }
}

impl std::fmt::Display for CosError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CosError::Unauthenticated(m) => write!(f, "tencent_cos_unauthenticated: {m}"),
            CosError::Forbidden(m) => write!(f, "tencent_cos_forbidden: {m}"),
            CosError::Network(m) => write!(f, "tencent_cos_network: {m}"),
            CosError::Unknown(m) => write!(f, "tencent_cos_unknown: {m}"),
        }
    }
}

impl std::error::Error for CosError {}

pub struct CosClient {
    region: String,
    bucket: String,
    secret_id: String,
    secret_key: String,
    http: reqwest::Client,
}

impl CosClient {
    pub fn new(
        region: impl Into<String>,
        bucket: impl Into<String>,
        secret_id: impl Into<String>,
        secret_key: impl Into<String>,
    ) -> Result<Self, CosError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| CosError::Network(e.to_string()))?;
        Ok(Self {
            region: region.into(),
            bucket: bucket.into(),
            secret_id: secret_id.into(),
            secret_key: secret_key.into(),
            http,
        })
    }

    pub fn host(&self) -> String {
        format!("{}.cos.{}.myqcloud.com", self.bucket, self.region)
    }

    fn object_url(&self, key: &str) -> String {
        format!("https://{}/{}", self.host(), encode_key_path(key))
    }

    /// 上传一个对象到 COS。失败按 4xx / 网络错分流。
    pub async fn put_object(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<(), CosError> {
        let now = unix_now_secs();
        let key_time = format!("{};{}", now, now + 3600);
        let mut headers: BTreeMap<&str, String> = BTreeMap::new();
        headers.insert("host", self.host());
        headers.insert("content-type", content_type.to_string());
        headers.insert("content-length", bytes.len().to_string());

        let authorization = build_authorization(
            "put",
            &format!("/{}", encode_key_path(key)),
            &headers,
            &BTreeMap::new(),
            &key_time,
            &self.secret_id,
            &self.secret_key,
        );

        let url = self.object_url(key);
        let resp = self
            .http
            .put(&url)
            .header("Host", self.host())
            .header("Content-Type", content_type)
            .header("Content-Length", bytes.len())
            .header("Authorization", authorization)
            .body(bytes)
            .send()
            .await
            .map_err(|e| CosError::Network(e.to_string()))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        match status.as_u16() {
            401 => Err(CosError::Unauthenticated(format!("HTTP {status}: {body}"))),
            403 => Err(CosError::Forbidden(format!("HTTP {status}: {body}"))),
            s if (400..500).contains(&s) => Err(CosError::Forbidden(format!("HTTP {status}: {body}"))),
            _ => Err(CosError::Unknown(format!("HTTP {status}: {body}"))),
        }
    }

    /// HEAD 探 bucket 是否存在 + 凭证有权限。Settings 测试连接用。
    pub async fn head_bucket(&self) -> Result<reqwest::StatusCode, CosError> {
        let now = unix_now_secs();
        let key_time = format!("{};{}", now, now + 600);
        let mut headers: BTreeMap<&str, String> = BTreeMap::new();
        headers.insert("host", self.host());

        let authorization = build_authorization(
            "head",
            "/",
            &headers,
            &BTreeMap::new(),
            &key_time,
            &self.secret_id,
            &self.secret_key,
        );
        let url = format!("https://{}/", self.host());
        let resp = self
            .http
            .head(&url)
            .header("Host", self.host())
            .header("Authorization", authorization)
            .send()
            .await
            .map_err(|e| CosError::Network(e.to_string()))?;
        Ok(resp.status())
    }

    /// 生成一个有效期内的 GET 预签名 URL（query-string 鉴权形式）。
    /// 给 ASR `CreateRecTask` 喂 `SourceType=0 + Url=<url>` 用。
    pub fn presigned_get_url(&self, key: &str, expires_secs: u64) -> Result<String, CosError> {
        let now = unix_now_secs();
        let key_time = format!("{};{}", now, now + expires_secs.max(60));
        let mut headers: BTreeMap<&str, String> = BTreeMap::new();
        headers.insert("host", self.host());

        let signature = compute_signature_components(
            "get",
            &format!("/{}", encode_key_path(key)),
            &headers,
            &BTreeMap::new(),
            &key_time,
            &self.secret_key,
        );

        // GET 预签名形式：把 q-* 字段按文档拼到 query string，url-encode 各字段值。
        // 注意：q-key-time / q-signature 这些值里出现 `;` `=` 必须保留为字面量；
        // 文档示例的预签名 URL 也是这样拼的（不对 q-* 做整体 url-encode）。
        let qs = format!(
            "q-sign-algorithm=sha1&q-ak={}&q-sign-time={}&q-key-time={}&q-header-list={}&q-url-param-list={}&q-signature={}",
            self.secret_id,
            key_time,
            key_time,
            signature.header_list,
            signature.url_param_list,
            signature.signature,
        );
        Ok(format!("{}?{}", self.object_url(key), qs))
    }

    /// best-effort 删除：失败只 warn，不返错。
    pub async fn delete_object_best_effort(&self, key: &str) {
        let now = unix_now_secs();
        let key_time = format!("{};{}", now, now + 600);
        let mut headers: BTreeMap<&str, String> = BTreeMap::new();
        headers.insert("host", self.host());

        let authorization = build_authorization(
            "delete",
            &format!("/{}", encode_key_path(key)),
            &headers,
            &BTreeMap::new(),
            &key_time,
            &self.secret_id,
            &self.secret_key,
        );
        let url = self.object_url(key);
        let res = self
            .http
            .delete(&url)
            .header("Host", self.host())
            .header("Authorization", authorization)
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => {
                log::warn!("[cos] delete {key} non-success: HTTP {}", r.status());
            }
            Err(e) => log::warn!("[cos] delete {key} failed: {e}"),
        }
    }
}

/// path 部分需要按 RFC3986 做 path-segment encode。COS key 里有 `/` 时各段保留，
/// 其它非 unreserved 字符 percent-encode。
fn encode_key_path(key: &str) -> String {
    let mut out = String::with_capacity(key.len() * 2);
    for b in key.bytes() {
        let safe = matches!(b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ─── 签名核心 ────────────────────────────────────────────────────────

/// COS Signature v5 各组件输出。
struct SignatureComponents {
    signature: String,
    header_list: String,    // 已小写、按 ASCII 排序、`;` 分隔
    url_param_list: String, // 同上；query 为空时是空串
}

/// 算 v5 签名。method 全小写；path 必须以 `/` 开头；headers / params 的 key
/// 全小写后排序，value 做 RFC3986 url-encode。
fn compute_signature_components(
    method: &str,
    path: &str,
    headers: &BTreeMap<&str, String>,
    params: &BTreeMap<&str, String>,
    key_time: &str,
    secret_key: &str,
) -> SignatureComponents {
    let header_list = sorted_lowercase_keys(headers);
    let url_param_list = sorted_lowercase_keys(params);
    let header_string = formatted_kv(headers);
    let param_string = formatted_kv(params);

    let http_string = format!(
        "{}\n{}\n{}\n{}\n",
        method.to_ascii_lowercase(),
        path,
        param_string,
        header_string,
    );
    let sha1_http = sha1_hex(http_string.as_bytes());

    let string_to_sign = format!("sha1\n{key_time}\n{sha1_http}\n");
    let sign_key = hmac_sha1_hex(secret_key.as_bytes(), key_time.as_bytes());
    let signature = hmac_sha1_hex(sign_key.as_bytes(), string_to_sign.as_bytes());

    SignatureComponents {
        signature,
        header_list,
        url_param_list,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_authorization(
    method: &str,
    path: &str,
    headers: &BTreeMap<&str, String>,
    params: &BTreeMap<&str, String>,
    key_time: &str,
    secret_id: &str,
    secret_key: &str,
) -> String {
    let comps = compute_signature_components(method, path, headers, params, key_time, secret_key);
    format!(
        "q-sign-algorithm=sha1&q-ak={}&q-sign-time={}&q-key-time={}&q-header-list={}&q-url-param-list={}&q-signature={}",
        secret_id, key_time, key_time, comps.header_list, comps.url_param_list, comps.signature
    )
}

fn sorted_lowercase_keys(m: &BTreeMap<&str, String>) -> String {
    let mut keys: Vec<String> = m.keys().map(|k| k.to_ascii_lowercase()).collect();
    keys.sort();
    keys.join(";")
}

/// 把 key/value 全部 lowercase + url-encode 后按 key 排序，拼成 `k1=v1&k2=v2`。
fn formatted_kv(m: &BTreeMap<&str, String>) -> String {
    let mut entries: Vec<(String, String)> = m
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), urlencode_rfc3986(v)))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// RFC3986 encode：unreserved 不动，其余 percent-encode（含空格 `!` `*` `(` `)` 等）。
fn urlencode_rfc3986(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        let safe = matches!(b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn sha1_hex(data: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(data);
    hex::encode(h.finalize())
}

fn hmac_sha1_hex(key: &[u8], data: &[u8]) -> String {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC-SHA1 接受任意密钥长度");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

// 备用：sha1 -> base64（保留以备将来给 Content-MD5 用，COS 实际不强制要求）
#[allow(dead_code)]
fn sha1_b64(data: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(data);
    B64.encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3986_encodes_special_chars() {
        assert_eq!(urlencode_rfc3986("hello world"), "hello%20world");
        assert_eq!(urlencode_rfc3986("a=b&c"), "a%3Db%26c");
        // unreserved 不动
        assert_eq!(urlencode_rfc3986("aZ09-_.~"), "aZ09-_.~");
    }

    #[test]
    fn encode_key_keeps_slashes_but_escapes_others() {
        assert_eq!(
            encode_key_path("recordings/2026-05-04/abc.wav"),
            "recordings/2026-05-04/abc.wav"
        );
        assert_eq!(encode_key_path("foo bar.wav"), "foo%20bar.wav");
        assert_eq!(encode_key_path("a/中文.wav"), "a/%E4%B8%AD%E6%96%87.wav");
    }

    #[test]
    fn sorted_keys_lowercase_and_sorted() {
        let mut m: BTreeMap<&str, String> = BTreeMap::new();
        m.insert("Host", "h".into());
        m.insert("Content-Type", "c".into());
        // lower + sort by ASCII
        assert_eq!(sorted_lowercase_keys(&m), "content-type;host");
    }

    /// HMAC-SHA1 RFC2202 测试向量（与 signature.rs 对齐），证明底层链路正确。
    #[test]
    fn hmac_sha1_known_vector() {
        let key = [0x0bu8; 20];
        let out = hmac_sha1_hex(&key, b"Hi There");
        assert_eq!(out, "b617318655057264e28bc0b6fb378c8ef146be00");
    }

    #[test]
    fn sha1_known_vector() {
        // FIPS180 标准向量
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    /// COS v5 签名核心：固定输入 → 固定输出，自洽性 + 防回归锚点。
    #[test]
    fn cos_signature_deterministic() {
        let mut headers: BTreeMap<&str, String> = BTreeMap::new();
        headers.insert("host", "examplebucket-1250000000.cos.ap-beijing.myqcloud.com".into());
        headers.insert("content-type", "audio/wav".into());
        headers.insert("content-length", "1024".into());
        let params: BTreeMap<&str, String> = BTreeMap::new();

        let key_time = "1700000000;1700003600";
        let sig1 = compute_signature_components(
            "put", "/recordings/abc.wav", &headers, &params, key_time, "test_secret_key",
        );
        let sig2 = compute_signature_components(
            "put", "/recordings/abc.wav", &headers, &params, key_time, "test_secret_key",
        );
        assert_eq!(sig1.signature, sig2.signature);
        // hex 40 字节
        assert_eq!(sig1.signature.len(), 40);
        assert!(sig1.signature.chars().all(|c| c.is_ascii_hexdigit()));
        // header-list 必须按 ASCII 升序、小写、`;` 分隔
        assert_eq!(sig1.header_list, "content-length;content-type;host");
        // 没有 query 参数
        assert_eq!(sig1.url_param_list, "");
    }

    /// 用文档 https://cloud.tencent.com/document/product/436/7778 的"GET 预签名"
    /// 例子做形态校验：Authorization 必含全部 6 段 q-* 字段。
    #[test]
    fn build_authorization_has_all_six_q_fields() {
        let mut headers: BTreeMap<&str, String> = BTreeMap::new();
        headers.insert("host", "examplebucket-1250000000.cos.ap-beijing.myqcloud.com".into());
        let params: BTreeMap<&str, String> = BTreeMap::new();
        let auth = build_authorization(
            "get",
            "/exampleobject",
            &headers,
            &params,
            "1700000000;1700003600",
            "AKID***",
            "secret",
        );
        assert!(auth.contains("q-sign-algorithm=sha1"));
        assert!(auth.contains("q-ak=AKID***"));
        assert!(auth.contains("q-sign-time=1700000000;1700003600"));
        assert!(auth.contains("q-key-time=1700000000;1700003600"));
        assert!(auth.contains("q-header-list=host"));
        assert!(auth.contains("q-url-param-list="));
        assert!(auth.contains("q-signature="));
    }

    #[test]
    fn presigned_get_url_format() {
        let cli = CosClient::new(
            "ap-shanghai",
            "myaudio-1234567890",
            "AKID_TEST",
            "test_key",
        )
        .unwrap();
        let url = cli.presigned_get_url("recordings/x.wav", 3600).unwrap();
        // 必须是 https 公网 host
        assert!(url.starts_with("https://myaudio-1234567890.cos.ap-shanghai.myqcloud.com/"));
        // 必须含 q-signature
        assert!(url.contains("q-signature="));
        assert!(url.contains("q-sign-algorithm=sha1"));
        assert!(url.contains("q-ak=AKID_TEST"));
        // path 部分编码正确
        assert!(url.contains("/recordings/x.wav?"));
    }

    #[test]
    fn cos_error_codes_stable() {
        assert_eq!(
            CosError::Unauthenticated("x".into()).code(),
            "tencent_cos_unauthenticated"
        );
        assert_eq!(CosError::Forbidden("x".into()).code(), "tencent_cos_forbidden");
        assert_eq!(CosError::Network("x".into()).code(), "tencent_cos_network");
        assert_eq!(CosError::Unknown("x".into()).code(), "tencent_cos_unknown");
    }

    /// 防回归：bucket / region 决定 host 拼接，不能漏后缀。
    #[test]
    fn host_format_correct() {
        let c = CosClient::new("ap-shanghai", "myaudio-1234567890", "id", "key").unwrap();
        assert_eq!(c.host(), "myaudio-1234567890.cos.ap-shanghai.myqcloud.com");
    }

    /// 同一输入跑两遍 presigned URL，只有 q-sign-time / q-key-time 因 unix time
    /// 不同会变；签名应不一样但格式一致。这里只是稳健性 smoke——主要确定性靠
    /// `cos_signature_deterministic`。
    #[test]
    fn presigned_url_smoke_runs_twice() {
        let cli = CosClient::new("ap-shanghai", "b-1", "id", "k").unwrap();
        let _ = cli.presigned_get_url("recordings/a.wav", 600).unwrap();
        let _ = cli.presigned_get_url("recordings/a.wav", 600).unwrap();
    }
}
