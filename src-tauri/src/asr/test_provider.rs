// 听写自定义供应商「测试连接」command。
//
// 目的：让用户在 Settings → Dictation provider 卡片上点一下「测试」，验证：
//   1. 凭证形态合法（必填字段不为空）
//   2. 凭证能通过供应商鉴权（不是错的 SecretKey / 过期 token）
//   3. 网络可达（DNS / TLS 通）
//
// 实现要点：选**最便宜的接口**做 round-trip：
//   - 腾讯：v3 签名调 `DescribeTaskStatus(TaskId=1)`。期望返回业务错
//     `FailedOperation.NoSuchTask` —— 业务错恰恰证明鉴权通过；若返回 `AuthFailure.*`
//     才是鉴权失败。
//   - 阿里：用 Bearer ApiKey 调一个 DashScope 任意只读 endpoint，按 401 区分。
//     这里用 GET `https://dashscope.aliyuncs.com/api/v1/tasks/test-credential`
//     —— 永远 404，但 401 vs 404 能区分密钥对错。
//
// 不存任何状态、不 emit 事件，纯请求 / 纯返回。

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::asr::aliyun::oss_upload::{BailianOssClient, OssUploadError, ReqwestBailianOssClient};
use crate::asr::tencent::cos::CosClient;
use crate::asr::tencent::file::{
    ACTION_QUERY, ASR_HOST, ASR_SERVICE, ASR_VERSION, DescribeTaskStatusRequest,
};
use crate::asr::tencent::signature::{
    build_authorization, build_canonical_request, build_string_to_sign, derive_signing_key,
    sha256_hex, sign_v3, utc_date_from_timestamp,
};

#[derive(Debug, Deserialize)]
#[serde(tag = "vendor", rename_all = "lowercase")]
pub enum DictationTestRequest {
    Tencent {
        #[serde(rename = "appId")]
        app_id: String,
        region: Option<String>,
        #[serde(rename = "secretId")]
        secret_id: String,
        #[serde(rename = "secretKey")]
        secret_key: String,
        #[serde(rename = "cosBucket", default)]
        cos_bucket: Option<String>,
    },
    Aliyun {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictationTestResult {
    pub ok: bool,
    /// 稳定错误码：unauthenticated / network / missing_fields / unknown
    pub code: String,
    pub message: String,
}

const ERR_UNAUTH: &str = "unauthenticated";
const ERR_NETWORK: &str = "network";
const ERR_MISSING: &str = "missing_fields";
const ERR_UNKNOWN: &str = "unknown";
const ERR_COS_UNAUTH: &str = "cos_unauthorized";
const ERR_COS_NOT_FOUND: &str = "cos_not_found";
const ERR_OSS_POLICY: &str = "oss_policy_failed";

#[tauri::command]
pub async fn dictation_test_provider(
    req: DictationTestRequest,
) -> Result<DictationTestResult, String> {
    match req {
        DictationTestRequest::Tencent {
            app_id,
            region,
            secret_id,
            secret_key,
            cos_bucket,
        } => Ok(test_tencent(
            &app_id,
            region.as_deref(),
            &secret_id,
            &secret_key,
            cos_bucket.as_deref(),
        )
        .await),
        DictationTestRequest::Aliyun { api_key } => Ok(test_aliyun(&api_key).await),
    }
}

async fn test_tencent(
    app_id: &str,
    region: Option<&str>,
    secret_id: &str,
    secret_key: &str,
    cos_bucket: Option<&str>,
) -> DictationTestResult {
    if app_id.trim().is_empty()
        || secret_id.trim().is_empty()
        || secret_key.trim().is_empty()
    {
        return DictationTestResult {
            ok: false,
            code: ERR_MISSING.into(),
            message: "AppID / SecretId / SecretKey is required".into(),
        };
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let date = utc_date_from_timestamp(timestamp);
    let region_str = region.unwrap_or("ap-shanghai").to_string();

    // 故意用一个不存在的 TaskId（1）来探活：
    //  - 鉴权通过 → 服务端走业务路径，返回 FailedOperation.NoSuchTask（200 OK + Error.Code）
    //  - 鉴权失败 → 返回 AuthFailure.*（200 OK + Error.Code）或非 200
    let body = DescribeTaskStatusRequest::new(1).to_json();

    // 公共参数 header（按 v3 协议签名）
    let payload_hash = sha256_hex(body.as_bytes());
    let canonical_headers = format!(
        "content-type:application/json; charset=utf-8\nhost:{ASR_HOST}\nx-tc-action:{}\n",
        ACTION_QUERY.to_ascii_lowercase()
    );
    let signed_headers = "content-type;host;x-tc-action";
    let canonical_request = build_canonical_request(
        "POST",
        "/",
        "",
        &canonical_headers,
        signed_headers,
        &payload_hash,
    );
    let string_to_sign = build_string_to_sign(timestamp, &date, ASR_SERVICE, &canonical_request);
    let key = derive_signing_key(secret_key, &date, ASR_SERVICE);
    let signature = sign_v3(&key, &string_to_sign);
    let authorization =
        build_authorization(secret_id, &date, ASR_SERVICE, signed_headers, &signature);

    let _ = app_id; // AppID 在录音文件接口非必填——保留参数让前端 schema 一致

    let http = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return network_err(&e.to_string()),
    };

    let resp = match http
        .post(format!("https://{ASR_HOST}/"))
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", ASR_HOST)
        .header("X-TC-Action", ACTION_QUERY)
        .header("X-TC-Version", ASR_VERSION)
        .header("X-TC-Region", &region_str)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return network_err(&e.to_string()),
    };

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // v3 在签名错时通常是 4xx（4xx 也带 Error.Code，但简单按 status 兜一层）
        return DictationTestResult {
            ok: false,
            code: classify_tencent_status_code(status.as_u16()),
            message: format!("HTTP {status}: {text}"),
        };
    }

    // 解析 Response.Error.Code 区分鉴权失败 vs 业务错（业务错 = 鉴权通过）
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return DictationTestResult {
                ok: false,
                code: ERR_UNKNOWN.into(),
                message: format!("response decode failed: {e}"),
            };
        }
    };
    let err_code = v
        .get("Response")
        .and_then(|r| r.get("Error"))
        .and_then(|e| e.get("Code"))
        .and_then(|c| c.as_str());
    let err_msg = v
        .get("Response")
        .and_then(|r| r.get("Error"))
        .and_then(|e| e.get("Message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");

    match err_code {
        // 鉴权失败：SecretId / SecretKey / 签名错
        Some(c) if c.starts_with("AuthFailure") => DictationTestResult {
            ok: false,
            code: ERR_UNAUTH.into(),
            message: format!("{c}: {err_msg}"),
        },
        // 服务未开通：算"凭证有效但需要去开通"——单独用一档码区分
        Some("FailedOperation.UserNotRegistered") => DictationTestResult {
            ok: false,
            code: "service_not_enabled".into(),
            message: format!("service not enabled: {err_msg}"),
        },
        // 没找到 task → 鉴权通过、业务上确实没这条任务，正是我们要的"测试通过"信号
        Some("FailedOperation.NoSuchTask") | None => {
            let bucket = cos_bucket.map(|b| b.trim()).filter(|b| !b.is_empty());
            if let Some(bucket) = bucket {
                probe_tencent_cos(&region_str, bucket, secret_id, secret_key).await
            } else {
                DictationTestResult {
                    ok: true,
                    code: "ok".into(),
                    message: "credentials verified".into(),
                }
            }
        }
        // 其他错误：记录但视作不通过——避免误判
        Some(c) => DictationTestResult {
            ok: false,
            code: ERR_UNKNOWN.into(),
            message: format!("{c}: {err_msg}"),
        },
    }
}

fn classify_tencent_status_code(status: u16) -> String {
    match status {
        401 | 403 => ERR_UNAUTH.into(),
        408 | 504 => "timeout".into(),
        429 => "rate_limited".into(),
        _ => ERR_NETWORK.into(),
    }
}

/// HEAD bucket 返回值映射：200 → ok；403 → cos_unauthorized；404 → cos_not_found；其他 → unknown。
fn classify_cos_status(status: u16) -> &'static str {
    match status {
        200 | 204 => "ok",
        401 | 403 => ERR_COS_UNAUTH,
        404 => ERR_COS_NOT_FOUND,
        408 | 504 => "timeout",
        429 => "rate_limited",
        _ => ERR_UNKNOWN,
    }
}

async fn probe_tencent_cos(
    region: &str,
    bucket: &str,
    secret_id: &str,
    secret_key: &str,
) -> DictationTestResult {
    let client = match CosClient::new(region, bucket, secret_id, secret_key) {
        Ok(c) => c,
        Err(e) => {
            return DictationTestResult {
                ok: false,
                code: ERR_NETWORK.into(),
                message: format!("COS client init failed: {e}"),
            };
        }
    };
    match client.head_bucket().await {
        Ok(status) => {
            let code = classify_cos_status(status.as_u16());
            if code == "ok" {
                DictationTestResult {
                    ok: true,
                    code: "ok".into(),
                    message: "credentials + COS bucket verified".into(),
                }
            } else {
                DictationTestResult {
                    ok: false,
                    code: code.into(),
                    message: format!("COS HEAD bucket failed: HTTP {status}"),
                }
            }
        }
        Err(e) => DictationTestResult {
            ok: false,
            code: ERR_NETWORK.into(),
            message: format!("COS HEAD bucket network error: {e}"),
        },
    }
}

async fn test_aliyun(api_key: &str) -> DictationTestResult {
    if api_key.trim().is_empty() {
        return DictationTestResult {
            ok: false,
            code: ERR_MISSING.into(),
            message: "ApiKey is required".into(),
        };
    }

    // DashScope task query：任意 task_id；
    //   - ApiKey 错：401 InvalidApiKey
    //   - ApiKey 对、task 不存在：404 / 业务错
    let url = "https://dashscope.aliyuncs.com/api/v1/tasks/test-credential-probe";
    let http = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return network_err(&e.to_string()),
    };
    let resp = match http
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return network_err(&e.to_string()),
    };

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if status.as_u16() == 401 || status.as_u16() == 403 {
        return DictationTestResult {
            ok: false,
            code: ERR_UNAUTH.into(),
            message: format!("HTTP {status}: {text}"),
        };
    }

    // 200 / 404 / 400 都算"鉴权通过"。DashScope 的 InvalidApiKey 走 401，其它都不是密钥问题。
    // ApiKey 通过后再探一次 OSS getPolicy——账号没开通 DashScope OSS 资源时这步会失败。
    probe_aliyun_oss_policy(api_key).await
}

async fn probe_aliyun_oss_policy(api_key: &str) -> DictationTestResult {
    let client = match ReqwestBailianOssClient::new() {
        Ok(c) => c,
        Err(e) => {
            return DictationTestResult {
                ok: false,
                code: ERR_NETWORK.into(),
                message: format!("OSS client init failed: {e}"),
            };
        }
    };
    match client.get_policy(api_key).await {
        Ok(_) => DictationTestResult {
            ok: true,
            code: "ok".into(),
            message: "credentials + OSS policy verified".into(),
        },
        Err(OssUploadError::Unauthenticated(m)) => DictationTestResult {
            ok: false,
            code: ERR_UNAUTH.into(),
            message: format!("OSS getPolicy unauthorized: {m}"),
        },
        Err(OssUploadError::Network(m)) => DictationTestResult {
            ok: false,
            code: ERR_NETWORK.into(),
            message: format!("OSS getPolicy network error: {m}"),
        },
        Err(e) => DictationTestResult {
            ok: false,
            code: ERR_OSS_POLICY.into(),
            message: format!("OSS getPolicy failed: {e}"),
        },
    }
}

fn network_err(detail: &str) -> DictationTestResult {
    DictationTestResult {
        ok: false,
        code: ERR_NETWORK.into(),
        message: detail.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_tencent_status() {
        assert_eq!(classify_tencent_status_code(401), ERR_UNAUTH);
        assert_eq!(classify_tencent_status_code(403), ERR_UNAUTH);
        assert_eq!(classify_tencent_status_code(429), "rate_limited");
        assert_eq!(classify_tencent_status_code(504), "timeout");
        assert_eq!(classify_tencent_status_code(500), ERR_NETWORK);
    }

    #[test]
    fn classify_cos_status_maps_each_code() {
        assert_eq!(classify_cos_status(200), "ok");
        assert_eq!(classify_cos_status(204), "ok");
        assert_eq!(classify_cos_status(401), ERR_COS_UNAUTH);
        assert_eq!(classify_cos_status(403), ERR_COS_UNAUTH);
        assert_eq!(classify_cos_status(404), ERR_COS_NOT_FOUND);
        assert_eq!(classify_cos_status(429), "rate_limited");
        assert_eq!(classify_cos_status(504), "timeout");
        assert_eq!(classify_cos_status(500), ERR_UNKNOWN);
    }

    #[tokio::test]
    async fn missing_fields_short_circuit_tencent() {
        let r = test_tencent("", None, "", "", None).await;
        assert!(!r.ok);
        assert_eq!(r.code, ERR_MISSING);
    }

    #[tokio::test]
    async fn missing_fields_short_circuit_aliyun() {
        let r = test_aliyun("").await;
        assert!(!r.ok);
        assert_eq!(r.code, ERR_MISSING);
    }
}
