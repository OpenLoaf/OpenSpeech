// 阿里百炼（DashScope）OSS 上传通道：filetrans 不接 base64，必须先把本地音频
// 通过百炼 getPolicy 拿临时凭证，再 multipart 上传到 OSS，拿 oss:// URL 给
// filetrans 提交任务用。
//
// 协议参考 docs/cloud-endpoints.md「阿里 DashScope BYOK」章节。
//
// 步骤：
//   1) GET https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3-asr-flash-filetrans
//      Header: Authorization: Bearer <ApiKey>
//      返回 { data: { policy, signature, upload_dir, upload_host, oss_access_key_id, ... } }
//   2) POST {upload_host}（multipart/form-data，字段顺序敏感，file 必须最后）
//      OSSAccessKeyId / Signature / policy / x-oss-object-acl /
//      x-oss-forbid-overwrite / key / success_action_status / file
//   3) 200 ⇒ oss URL：oss://{bucket}/{upload_dir}/{filename}
//      （bucket 从 upload_host 的二级域名解析；filetrans 必须传 oss:// 而不是 https://）

use serde::Deserialize;
use std::time::Duration;

const POLICY_URL: &str = "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3-asr-flash-filetrans";

#[derive(Debug, Clone)]
pub enum OssUploadError {
    Unauthenticated(String),
    PolicyExpired,
    FileTooLarge { actual_bytes: u64, max_bytes: u64 },
    Network(String),
    Decode(String),
    Upload(String),
}

impl OssUploadError {
    pub fn code(&self) -> &'static str {
        match self {
            OssUploadError::Unauthenticated(_) => "aliyun_unauthenticated",
            OssUploadError::PolicyExpired => "aliyun_policy_expired",
            OssUploadError::FileTooLarge { .. } => "aliyun_file_too_large",
            OssUploadError::Network(_) => "aliyun_network_error",
            OssUploadError::Decode(_) => "aliyun_upload_failed",
            OssUploadError::Upload(_) => "aliyun_upload_failed",
        }
    }
}

impl std::fmt::Display for OssUploadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OssUploadError::Unauthenticated(m) => write!(f, "aliyun_unauthenticated: {m}"),
            OssUploadError::PolicyExpired => write!(f, "aliyun_policy_expired"),
            OssUploadError::FileTooLarge { actual_bytes, max_bytes } => {
                write!(f, "aliyun_file_too_large: {actual_bytes} > {max_bytes}")
            }
            OssUploadError::Network(m) => write!(f, "aliyun_network_error: {m}"),
            OssUploadError::Decode(m) => write!(f, "aliyun_upload_failed: decode {m}"),
            OssUploadError::Upload(m) => write!(f, "aliyun_upload_failed: {m}"),
        }
    }
}

impl std::error::Error for OssUploadError {}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadPolicyEnvelope {
    pub data: UploadPolicy,
    #[serde(default)]
    #[allow(dead_code)]
    pub request_id: Option<String>,
}

/// /api/v1/uploads?action=getPolicy 的 `data` 段。
#[derive(Debug, Clone, Deserialize)]
pub struct UploadPolicy {
    pub policy: String,
    pub signature: String,
    pub upload_dir: String,
    pub upload_host: String,
    pub oss_access_key_id: String,
    #[serde(default)]
    pub x_oss_object_acl: String,
    #[serde(default)]
    pub x_oss_forbid_overwrite: String,
    #[serde(default)]
    pub expire_in_seconds: u64,
    #[serde(default)]
    pub max_file_size_mb: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub capacity_limit_mb: u64,
}

impl UploadPolicy {
    /// 根据 upload_host 推导 bucket（filetrans 协议要求传 oss://{bucket}/...）。
    /// upload_host 形如 https://dashscope-instant.oss-cn-beijing.aliyuncs.com，
    /// bucket = `dashscope-instant`。
    pub fn bucket_from_upload_host(&self) -> Option<String> {
        let host = self
            .upload_host
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        let first = host.split('.').next()?;
        if first.is_empty() {
            None
        } else {
            Some(first.to_string())
        }
    }

    /// 单文件 byte 上限（policy 没给的话兜 100MB）。
    pub fn max_bytes(&self) -> u64 {
        let mb = if self.max_file_size_mb == 0 { 100 } else { self.max_file_size_mb };
        mb.saturating_mul(1024 * 1024)
    }
}

/// 一次构造好的 multipart 字段集合，按协议顺序排列；`file` 一定在最后。
#[derive(Debug, Clone, PartialEq)]
pub struct OrderedMultipart {
    pub fields: Vec<(String, String)>,
    pub key: String,
    pub file_name: String,
    pub file_bytes: Vec<u8>,
    pub upload_host: String,
}

pub fn build_ordered_multipart(
    policy: &UploadPolicy,
    file_name: &str,
    bytes: Vec<u8>,
) -> OrderedMultipart {
    let key = format!(
        "{}/{}",
        policy.upload_dir.trim_end_matches('/'),
        file_name
    );
    let fields = vec![
        ("OSSAccessKeyId".into(), policy.oss_access_key_id.clone()),
        ("Signature".into(), policy.signature.clone()),
        ("policy".into(), policy.policy.clone()),
        ("x-oss-object-acl".into(), policy.x_oss_object_acl.clone()),
        (
            "x-oss-forbid-overwrite".into(),
            policy.x_oss_forbid_overwrite.clone(),
        ),
        ("key".into(), key.clone()),
        ("success_action_status".into(), "200".into()),
    ];
    OrderedMultipart {
        fields,
        key,
        file_name: file_name.to_string(),
        file_bytes: bytes,
        upload_host: policy.upload_host.clone(),
    }
}

/// 上传成功后，把 policy + key 拼成 filetrans 协议要求的 oss URL。
pub fn oss_url_for(policy: &UploadPolicy, key: &str) -> Result<String, OssUploadError> {
    let bucket = policy
        .bucket_from_upload_host()
        .ok_or_else(|| OssUploadError::Decode(format!("bad upload_host: {}", policy.upload_host)))?;
    Ok(format!("oss://{bucket}/{key}"))
}

#[async_trait::async_trait]
pub trait BailianOssClient: Send + Sync {
    async fn get_policy(&self, api_key: &str) -> Result<UploadPolicy, OssUploadError>;
    async fn upload_file(
        &self,
        policy: &UploadPolicy,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<String, OssUploadError>;
}

pub struct ReqwestBailianOssClient {
    client: reqwest::Client,
}

impl ReqwestBailianOssClient {
    pub fn new() -> Result<Self, OssUploadError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| OssUploadError::Network(e.to_string()))?;
        Ok(Self { client })
    }

    #[allow(dead_code)]
    pub fn from_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait::async_trait]
impl BailianOssClient for ReqwestBailianOssClient {
    async fn get_policy(&self, api_key: &str) -> Result<UploadPolicy, OssUploadError> {
        let resp = self
            .client
            .get(POLICY_URL)
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await
            .map_err(|e| OssUploadError::Network(e.to_string()))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| OssUploadError::Network(e.to_string()))?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(OssUploadError::Unauthenticated(format!(
                "HTTP {status}: {body}"
            )));
        }
        if !status.is_success() {
            return Err(OssUploadError::Network(format!("HTTP {status}: {body}")));
        }
        let env: UploadPolicyEnvelope = serde_json::from_str(&body)
            .map_err(|e| OssUploadError::Decode(format!("getPolicy: {e}; body={body}")))?;
        Ok(env.data)
    }

    async fn upload_file(
        &self,
        policy: &UploadPolicy,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<String, OssUploadError> {
        let max = policy.max_bytes();
        let actual = bytes.len() as u64;
        if actual > max {
            return Err(OssUploadError::FileTooLarge {
                actual_bytes: actual,
                max_bytes: max,
            });
        }
        let ordered = build_ordered_multipart(policy, file_name, bytes);
        let mut form = reqwest::multipart::Form::new();
        for (k, v) in &ordered.fields {
            form = form.text(k.clone(), v.clone());
        }
        let part = reqwest::multipart::Part::bytes(ordered.file_bytes.clone())
            .file_name(ordered.file_name.clone())
            .mime_str("application/octet-stream")
            .map_err(|e| OssUploadError::Upload(e.to_string()))?;
        form = form.part("file", part);

        let resp = self
            .client
            .post(&ordered.upload_host)
            .multipart(form)
            .send()
            .await
            .map_err(|e| OssUploadError::Network(e.to_string()))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 403 {
            // OSS policy 过期或签名失效都是 403，文档里把过期 policy 归到这里。
            // 调用方拿到 PolicyExpired 后可以重新 get_policy 一次再试。
            if body.contains("Expired") || body.contains("expired") {
                return Err(OssUploadError::PolicyExpired);
            }
            return Err(OssUploadError::Upload(format!("HTTP 403: {body}")));
        }
        if !status.is_success() {
            return Err(OssUploadError::Upload(format!("HTTP {status}: {body}")));
        }
        oss_url_for(policy, &ordered.key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_policy_json() -> &'static str {
        r#"{
            "data": {
                "policy": "POLICY_B64",
                "signature": "SIG_B64",
                "upload_dir": "tmp/abc",
                "upload_host": "https://dashscope-instant.oss-cn-beijing.aliyuncs.com",
                "expire_in_seconds": 172800,
                "max_file_size_mb": 100,
                "capacity_limit_mb": 500,
                "oss_access_key_id": "OSS_AK",
                "x_oss_object_acl": "private",
                "x_oss_forbid_overwrite": "true"
            },
            "request_id": "rid-1"
        }"#
    }

    #[test]
    fn parse_policy_envelope() {
        let env: UploadPolicyEnvelope = serde_json::from_str(sample_policy_json()).unwrap();
        assert_eq!(env.data.policy, "POLICY_B64");
        assert_eq!(env.data.signature, "SIG_B64");
        assert_eq!(env.data.upload_dir, "tmp/abc");
        assert_eq!(env.data.upload_host, "https://dashscope-instant.oss-cn-beijing.aliyuncs.com");
        assert_eq!(env.data.oss_access_key_id, "OSS_AK");
        assert_eq!(env.data.x_oss_object_acl, "private");
        assert_eq!(env.data.x_oss_forbid_overwrite, "true");
        assert_eq!(env.data.max_file_size_mb, 100);
    }

    #[test]
    fn bucket_inferred_from_upload_host() {
        let env: UploadPolicyEnvelope = serde_json::from_str(sample_policy_json()).unwrap();
        assert_eq!(env.data.bucket_from_upload_host().as_deref(), Some("dashscope-instant"));
    }

    #[test]
    fn max_bytes_falls_back_to_100mb_when_missing() {
        let mut p: UploadPolicy = serde_json::from_str::<UploadPolicyEnvelope>(sample_policy_json())
            .unwrap()
            .data;
        p.max_file_size_mb = 0;
        assert_eq!(p.max_bytes(), 100 * 1024 * 1024);
    }

    #[test]
    fn ordered_multipart_field_order_and_key() {
        // 字段顺序对 OSS PostObject 严格敏感（policy / signature / x-oss-* /
        // key / success_action_status / file），任何顺序错位都会触发 403。
        let env: UploadPolicyEnvelope = serde_json::from_str(sample_policy_json()).unwrap();
        let m = build_ordered_multipart(&env.data, "audio.wav", vec![1, 2, 3, 4]);
        let names: Vec<&str> = m.fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "OSSAccessKeyId",
                "Signature",
                "policy",
                "x-oss-object-acl",
                "x-oss-forbid-overwrite",
                "key",
                "success_action_status",
            ]
        );
        // key = upload_dir/<file_name>
        assert_eq!(m.key, "tmp/abc/audio.wav");
        // success_action_status 必须是字符串 "200"
        let status = m
            .fields
            .iter()
            .find(|(k, _)| k == "success_action_status")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert_eq!(status, "200");
        // file 内容透传
        assert_eq!(m.file_bytes, vec![1, 2, 3, 4]);
        assert_eq!(m.file_name, "audio.wav");
    }

    #[test]
    fn ordered_multipart_carries_policy_signature_acl_verbatim() {
        let env: UploadPolicyEnvelope = serde_json::from_str(sample_policy_json()).unwrap();
        let m = build_ordered_multipart(&env.data, "x.wav", vec![]);
        let lookup = |k: &str| -> Option<String> {
            m.fields
                .iter()
                .find(|(name, _)| name == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(lookup("OSSAccessKeyId").as_deref(), Some("OSS_AK"));
        assert_eq!(lookup("Signature").as_deref(), Some("SIG_B64"));
        assert_eq!(lookup("policy").as_deref(), Some("POLICY_B64"));
        assert_eq!(lookup("x-oss-object-acl").as_deref(), Some("private"));
        assert_eq!(lookup("x-oss-forbid-overwrite").as_deref(), Some("true"));
    }

    #[test]
    fn oss_url_format_matches_filetrans_protocol() {
        let env: UploadPolicyEnvelope = serde_json::from_str(sample_policy_json()).unwrap();
        let url = oss_url_for(&env.data, "tmp/abc/audio.wav").unwrap();
        assert_eq!(url, "oss://dashscope-instant/tmp/abc/audio.wav");
    }

    #[test]
    fn oss_url_rejects_invalid_upload_host() {
        let mut p: UploadPolicy = serde_json::from_str::<UploadPolicyEnvelope>(sample_policy_json())
            .unwrap()
            .data;
        p.upload_host = String::new();
        let err = oss_url_for(&p, "tmp/abc/x").unwrap_err();
        assert!(matches!(err, OssUploadError::Decode(_)));
    }

    #[test]
    fn upload_dir_with_trailing_slash_does_not_double_up() {
        let mut p: UploadPolicy = serde_json::from_str::<UploadPolicyEnvelope>(sample_policy_json())
            .unwrap()
            .data;
        p.upload_dir = "tmp/abc/".into();
        let m = build_ordered_multipart(&p, "x.wav", vec![]);
        assert_eq!(m.key, "tmp/abc/x.wav");
    }

    #[test]
    fn error_codes_are_stable_for_humanize() {
        assert_eq!(OssUploadError::Unauthenticated("x".into()).code(), "aliyun_unauthenticated");
        assert_eq!(OssUploadError::PolicyExpired.code(), "aliyun_policy_expired");
        assert_eq!(
            OssUploadError::FileTooLarge { actual_bytes: 1, max_bytes: 0 }.code(),
            "aliyun_file_too_large"
        );
        assert_eq!(OssUploadError::Network("x".into()).code(), "aliyun_network_error");
        assert_eq!(OssUploadError::Upload("x".into()).code(), "aliyun_upload_failed");
        assert_eq!(OssUploadError::Decode("x".into()).code(), "aliyun_upload_failed");
    }
}
