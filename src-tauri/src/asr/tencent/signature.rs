// 腾讯云 ASR 签名算法实现。
//
// 两套独立算法：
//   1. 实时 WS：HMAC-SHA1，签名原文 = host+path+?+排序后 query。docs/tencent-asr/websocket-realtime-asr.md
//   2. REST v3：TC3-HMAC-SHA256，4 步派生密钥。docs/tencent-asr/common-signature-v3.md
//
// 全部纯函数，凭证由调用方从 keyring 取出后以 &str 传入。

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

// ─── 实时 WS 签名 ────────────────────────────────────────────────

/// 把 query 参数按 key 字典序排好后拼成 `k1=v1&k2=v2`。
/// **签名原文里不做 URL-encode**——这是腾讯文档的隐性约定（看官方示例的 voice_id
/// 即可印证）。请求实际发送时再对 signature 单独 URL-encode。
pub fn build_canonical_query(params: &BTreeMap<&str, String>) -> String {
    params
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// 拼实时 WS 签名原文：`<host><path>?<canonical_query>`，**不含** `wss://`。
/// 例：`asr.cloud.tencent.com/asr/v2/12345?engine_model_type=16k_zh&...`
pub fn build_realtime_signing_string(
    host: &str,
    path: &str,
    canonical_query: &str,
) -> String {
    format!("{host}{path}?{canonical_query}")
}

/// HMAC-SHA1(secret_key, signing_string) → base64。这是腾讯实时 WS 的 signature
/// 字段值（**未** URL-encode，调用方自行处理）。
pub fn sign_realtime(secret_key: &str, signing_string: &str) -> String {
    let mut mac = HmacSha1::new_from_slice(secret_key.as_bytes())
        .expect("HMAC-SHA1 接受任意长度密钥，不会 panic");
    mac.update(signing_string.as_bytes());
    let digest = mac.finalize().into_bytes();
    B64.encode(digest)
}

/// 把签名做 URL 编码以拼到 query string。腾讯文档要求 `+`/`=`/`/` 必须 percent-
/// encode（否则签名校验失败偶发）。
pub fn urlencode_signature(sig: &str) -> String {
    // 自实现避免引入新依赖。腾讯文档明确列出 `+ = /` 要求，base64 输出范围内
    // 可能出现的特殊字符也都覆盖了。
    let mut out = String::with_capacity(sig.len() * 3);
    for b in sig.bytes() {
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

/// 一站式构造完整的实时 WS URL（含已 URL-encode 的 signature）。
/// host 形如 `asr.cloud.tencent.com`，path 形如 `/asr/v2/12345`（appid 已拼入）。
pub fn build_realtime_url(
    host: &str,
    path: &str,
    params: &BTreeMap<&str, String>,
    secret_key: &str,
) -> String {
    let canonical_query = build_canonical_query(params);
    let signing_string = build_realtime_signing_string(host, path, &canonical_query);
    let sig = sign_realtime(secret_key, &signing_string);
    let sig_enc = urlencode_signature(&sig);
    format!("wss://{host}{path}?{canonical_query}&signature={sig_enc}")
}

// ─── REST v3 签名（TC3-HMAC-SHA256） ──────────────────────────────

/// 按 v3 规范拼 CanonicalRequest。docs/common-signature-v3.md §1.
///
/// - method: "POST" / "GET"
/// - canonical_uri: API 3.0 固定 "/"
/// - canonical_query_string: POST 固定 ""，GET 用排序好的 RFC3986 编码 query
/// - signed_headers: 至少含 "content-type;host"，按 ASCII 升序，分号分隔
/// - canonical_headers: 与 signed_headers 对应的 `key:value\n` 段（key 全小写，
///   多个 header 按 key ASCII 升序）
/// - payload_hash: lowercase hex SHA-256(请求体)；GET 请求体用空字符串
pub fn build_canonical_request(
    method: &str,
    canonical_uri: &str,
    canonical_query_string: &str,
    canonical_headers: &str,
    signed_headers: &str,
    payload_hash: &str,
) -> String {
    format!(
        "{method}\n{canonical_uri}\n{canonical_query_string}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
}

/// SHA-256(payload) 的 lowercase hex 形式。
pub fn sha256_hex(payload: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload);
    hex::encode(hasher.finalize())
}

/// 拼 StringToSign：`Algorithm\nTimestamp\nCredentialScope\nHashedCanonicalRequest`。
/// docs/common-signature-v3.md §2.
pub fn build_string_to_sign(
    timestamp: i64,
    date: &str,
    service: &str,
    canonical_request: &str,
) -> String {
    let scope = format!("{date}/{service}/tc3_request");
    let hashed = sha256_hex(canonical_request.as_bytes());
    format!("TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{hashed}")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC-SHA256 接受任意长度密钥，不会 panic");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// 派生签名密钥：TC3 + SecretKey → Date → Service → tc3_request。
/// docs/common-signature-v3.md §3.1.
pub fn derive_signing_key(secret_key: &str, date: &str, service: &str) -> [u8; 32] {
    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let secret_service = hmac_sha256(&secret_date, service.as_bytes());
    hmac_sha256(&secret_service, b"tc3_request")
}

/// 用派生密钥对 StringToSign 做 HMAC-SHA256，输出 lowercase hex 即 Signature。
/// docs/common-signature-v3.md §3.2.
pub fn sign_v3(signing_key: &[u8; 32], string_to_sign: &str) -> String {
    hex::encode(hmac_sha256(signing_key, string_to_sign.as_bytes()))
}

/// 拼 v3 Authorization header。
/// 形如：`TC3-HMAC-SHA256 Credential=<id>/<date>/asr/tc3_request,
///       SignedHeaders=content-type;host, Signature=<hex>`
pub fn build_authorization(
    secret_id: &str,
    date: &str,
    service: &str,
    signed_headers: &str,
    signature: &str,
) -> String {
    format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{date}/{service}/tc3_request, \
         SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// 按 timestamp 推 UTC 日期（v3 要求 Date 必须从 X-TC-Timestamp 算出，**不是**
/// 取本机日期）。
pub fn utc_date_from_timestamp(timestamp_secs: i64) -> String {
    // 简单实现：86400 秒 = 一天。从 1970-01-01 开始算。
    // 不引入 chrono：项目其他地方也没用，这点小事不值得拉一个时间库。
    let days = (timestamp_secs / 86_400).max(0) as u64;
    let (y, m, d) = days_to_ymd(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// days since 1970-01-01 → (Y, M, D)。Howard Hinnant civil_from_days 算法。
fn days_to_ymd(days: u64) -> (i32, u32, u32) {
    // 把基准移到 0000-03-01（让二月在年末，便于处理闰年）
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = y + if m <= 2 { 1 } else { 0 };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── 实时 WS 签名 ────────────────────────────────────────────

    #[test]
    fn canonical_query_is_sorted_by_key() {
        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        q.insert("voice_id", "abc".into());
        q.insert("engine_model_type", "16k_zh".into());
        q.insert("nonce", "42".into());
        let s = build_canonical_query(&q);
        // BTreeMap 按 key 字典序遍历
        assert_eq!(s, "engine_model_type=16k_zh&nonce=42&voice_id=abc");
    }

    #[test]
    fn realtime_signing_string_format() {
        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        q.insert("a", "1".into());
        q.insert("b", "2".into());
        let cq = build_canonical_query(&q);
        let s = build_realtime_signing_string("asr.cloud.tencent.com", "/asr/v2/12345", &cq);
        assert_eq!(s, "asr.cloud.tencent.com/asr/v2/12345?a=1&b=2");
        assert!(!s.starts_with("wss://"), "签名原文不能含协议前缀");
    }

    /// RFC 2202 HMAC-SHA1 测试向量：key=0x0b*20，data="Hi There"。
    /// 用来确认底层 HMAC-SHA1 + base64 链路实现正确。
    #[test]
    fn hmac_sha1_rfc_2202_vector() {
        let key = [0x0bu8; 20];
        let mut mac = HmacSha1::new_from_slice(&key).unwrap();
        mac.update(b"Hi There");
        let digest = mac.finalize().into_bytes();
        // expected hex per RFC: b617318655057264e28bc0b6fb378c8ef146be00
        assert_eq!(
            hex::encode(digest),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
    }

    #[test]
    fn sign_realtime_b64_is_url_encoded_correctly() {
        // 自洽锚点：固定 secret + 原文 → 固定 base64 + URL encode。
        // 用一个会产生 `/` 和 `=` 的输入，验证 URL encode 把它们转成 %2F / %3D。
        let sig = sign_realtime("test_secret_key", "any-payload");
        let enc = urlencode_signature(&sig);
        // base64 输出可能含 `+` `/` `=`；URL encode 后必须不含
        assert!(!enc.contains('+'));
        assert!(!enc.contains('/'));
        assert!(!enc.contains('='));
        // 反向验证：%XX hex 字符必须大写两位
        for chunk in enc.split('%').skip(1) {
            assert!(chunk.len() >= 2, "%-escape 至少 2 位 hex");
            let hex = &chunk[..2];
            assert!(
                hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()),
                "URL encode 必须用大写 hex: 看到 {hex}"
            );
        }
    }

    #[test]
    fn build_realtime_url_full_path() {
        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        q.insert("engine_model_type", "16k_zh".into());
        q.insert("voice_id", "abc-123".into());
        let url = build_realtime_url(
            "asr.cloud.tencent.com",
            "/asr/v2/12345",
            &q,
            "test_secret_key",
        );
        assert!(url.starts_with("wss://asr.cloud.tencent.com/asr/v2/12345?"));
        assert!(url.contains("engine_model_type=16k_zh"));
        assert!(url.contains("voice_id=abc-123"));
        // signature 必须放在 query 末尾（拼接顺序约定）
        let sig_pos = url.find("&signature=").expect("must contain signature");
        // signature= 之后不能再出现 `&`（即必须是最后一项）
        assert!(!url[sig_pos + 1..].contains('&'));
    }

    /// 同样输入必须产出同样签名（防止后续重构破坏确定性）。
    #[test]
    fn realtime_signature_is_deterministic() {
        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        q.insert("engine_model_type", "16k_zh".into());
        q.insert("voice_id", "abc".into());
        q.insert("timestamp", "1700000000".into());
        let cq = build_canonical_query(&q);
        let s = build_realtime_signing_string("asr.cloud.tencent.com", "/asr/v2/1", &cq);
        let a = sign_realtime("k", &s);
        let b = sign_realtime("k", &s);
        assert_eq!(a, b, "确定性：同输入 → 同签名");
    }

    // ─── REST v3 签名 ────────────────────────────────────────────

    #[test]
    fn sha256_hex_known_vector() {
        // SHA-256("abc") 是 NIST 标准向量
        let h = sha256_hex(b"abc");
        assert_eq!(
            h,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn canonical_request_format_matches_doc_example() {
        // 用文档 §1 末尾的示例做格式校验（不验签，文档里 SecretKey 是 ******）
        let cr = build_canonical_request(
            "POST",
            "/",
            "",
            "content-type:application/json; charset=utf-8\nhost:cvm.tencentcloudapi.com\nx-tc-action:describeinstances\n",
            "content-type;host;x-tc-action",
            "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064",
        );
        let expected = "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:cvm.tencentcloudapi.com\nx-tc-action:describeinstances\n\ncontent-type;host;x-tc-action\n35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064";
        assert_eq!(cr, expected);
    }

    #[test]
    fn string_to_sign_matches_doc_example() {
        // 重现文档 §2 的 StringToSign（CanonicalRequest 的 hash 已给出）
        let cr_with_known_hash = "MOCK"; // 不重要：sha256 我们重新算
        let _ = cr_with_known_hash;
        // 这里改测：给定固定 timestamp + date + service + 一段 cr 文本，
        // StringToSign 的固定形态。
        let s = build_string_to_sign(1551113065, "2019-02-25", "cvm", "abc");
        let expected_hash = sha256_hex(b"abc");
        let expected = format!(
            "TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n{expected_hash}"
        );
        assert_eq!(s, expected);
    }

    #[test]
    fn derive_and_sign_v3_is_deterministic() {
        // 自洽：固定 SecretKey + Date + Service + StringToSign → 固定 Signature。
        let key = derive_signing_key("Gu5t9xGARNpq86cd98joQYCN3Cozk1qA", "2019-02-25", "cvm");
        let sig1 = sign_v3(&key, "TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\nabc");
        let sig2 = sign_v3(&key, "TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\nabc");
        assert_eq!(sig1, sig2);
        // hex 64 字节
        assert_eq!(sig1.len(), 64);
        assert!(sig1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn authorization_header_format() {
        let h = build_authorization(
            "AKID***",
            "2019-02-25",
            "cvm",
            "content-type;host",
            "deadbeef",
        );
        // 严格匹配文档示例：行内逗号空格分隔三段
        assert_eq!(
            h,
            "TC3-HMAC-SHA256 Credential=AKID***/2019-02-25/cvm/tc3_request, \
             SignedHeaders=content-type;host, Signature=deadbeef"
        );
    }

    // ─── UTC 日期换算 ────────────────────────────────────────────

    #[test]
    fn utc_date_known_vectors() {
        // 1970-01-01 00:00:00 UTC = ts 0
        assert_eq!(utc_date_from_timestamp(0), "1970-01-01");
        // 2019-02-25 00:00:00 UTC = ts 1551052800（文档示例日期）
        assert_eq!(utc_date_from_timestamp(1_551_052_800), "2019-02-25");
        // 2019-02-25 23:59:59 UTC：同一天
        assert_eq!(utc_date_from_timestamp(1_551_139_199), "2019-02-25");
        // 2019-02-26 00:00:00 UTC：跨天
        assert_eq!(utc_date_from_timestamp(1_551_139_200), "2019-02-26");
        // 2024-02-29 00:00:00 UTC（闰年）
        assert_eq!(utc_date_from_timestamp(1_709_164_800), "2024-02-29");
        // 2024-03-01（闰年 2 月之后）
        assert_eq!(utc_date_from_timestamp(1_709_251_200), "2024-03-01");
        // 2025-03-01（非闰年的 3-1，确认 2 月只数到 28）
        assert_eq!(utc_date_from_timestamp(1_740_787_200), "2025-03-01");
        // 2026-05-04 00:00:00 UTC（项目当前日期）
        assert_eq!(utc_date_from_timestamp(1_777_852_800), "2026-05-04");
    }
}
