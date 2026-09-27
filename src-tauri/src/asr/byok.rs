// BYOK 听写通道 dispatch 骨架。
//
// 前端在 stt_start / transcribe_recording_file 命令上透传 ProviderRefDto，
// dispatch() 把它解析成 DictationBackend：
//   mode=saas      ⇒ SaasRealtime / SaasFile（保持现有 OpenLoaf 链路）
//   mode=custom    ⇒ 从 keyring 拼出 TencentRealtime / TencentFile / Aliyun*
//   mode=local     ⇒ LocalRealtime / LocalFile（离线模型，见 local_asr/）
//
// PR-3 只搭骨架：Saas* 仍走原 SaaS 实现，Custom 分支由调用方返回
// `byok_not_implemented_yet`。腾讯 / 阿里实现见后续 PR-4 / 5 / 6 / 7。
//
// 衔接点：
// - DictationBackend 是后续 PR 的接入面：tencent / aliyun 模块拿到所需字段
//   后即可独立实现各自的 realtime / file 路径。
// - provider_kind_str() 与前端 ProviderKind 字面量、history.provider_kind 列对齐。

use serde::Deserialize;

use crate::secrets::{DictationCredentials, load_dictation_provider_credentials_for_rust};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderMode {
    Saas,
    Custom,
    Local,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CustomVendor {
    Tencent,
    Aliyun,
}

#[derive(Debug, Clone, Copy)]
pub enum DictationModality {
    Realtime,
    File,
}

/// 前端透传过来的 active provider 引用。
///
/// 字段名按 invoke 序列化默认（serde camelCase）。tencent_app_id / tencent_region
/// 是非 secret，留在 settings.json 里随 ProviderRef 一起送过来；secret 字段（SecretId
/// / SecretKey / ApiKey）由 Rust 自己读 keyring，从不 IPC 传输。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRef {
    pub mode: ProviderMode,
    #[serde(default)]
    pub active_custom_provider_id: Option<String>,
    #[serde(default)]
    pub custom_provider_vendor: Option<CustomVendor>,
    #[serde(default)]
    pub tencent_app_id: Option<String>,
    #[serde(default)]
    pub tencent_region: Option<String>,
    /// 腾讯云 COS bucket（含 appid 后缀，如 `myaudio-1234567890`）。None / 空 = 走
    /// base64 直传（≤5MB）；填了走 COS 上传（≤512MB）。
    #[serde(default)]
    pub tencent_cos_bucket: Option<String>,
    /// UI 上的别名（写日志 / 错误文案兜底用，可空）。
    #[serde(default)]
    pub custom_provider_name: Option<String>,
    /// mode=local 时选中的本地模型 id（local_asr::catalog）。
    #[serde(default)]
    pub local_model_id: Option<String>,
}

// PR-4 起 TencentRealtime 字段被 stt/mod.rs 消费；File / Aliyun 分支由 PR-5 / 6 / 7
// 接入。File 路径目前只用 secret_id/secret_key/region/api_key，app_id / name 是
// 协议形状的一部分（日志 / 后续配额 / 多 provider 切换会用），加 allow_dead 避免
// 误删——结构体级 allow 比字段级更紧凑。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum DictationBackend {
    SaasRealtime,
    SaasFile,
    TencentRealtime {
        app_id: String,
        region: String,
        secret_id: String,
        secret_key: String,
        name: String,
    },
    TencentFile {
        app_id: String,
        region: String,
        secret_id: String,
        secret_key: String,
        name: String,
        /// COS bucket 必填；None / 空字符串后端直接拒绝转写（ERR_TENCENT_COS_BUCKET_REQUIRED）。
        cos_bucket: Option<String>,
    },
    AliyunRealtime {
        api_key: String,
        name: String,
    },
    AliyunFile {
        api_key: String,
        name: String,
    },
    LocalRealtime {
        model_id: String,
    },
    LocalFile {
        model_id: String,
    },
}

#[derive(Debug, Clone)]
pub enum BackendDispatchError {
    /// 用户切到 custom 但结构性没配：active provider id 缺失 / vendor 缺失 / 列表空。
    /// 调用方据此自动 fallback 到 SaaS——用户根本没设过自定义供应商，硬报错没意义。
    ProviderNotConfigured { provider_id: Option<String> },
    /// provider 选好了、vendor 也对得上，但 keyring 里读不到对应密钥（或 app_id 这类
    /// 必填非 secret 字段没填）。说明用户主动配过但缺东西，不 fallback——避免悄悄
    /// 跳过用户的配置意图掩盖问题。
    MissingCredentials { provider_id: Option<String> },
    /// keyring 读取层异常（解码失败 / OS 钥匙串报错）。
    KeyringError(String),
    /// 选了本地通道但没选模型。不 fallback 到 SaaS：用户明确要求离线，悄悄把录音
    /// 送上云违背隐私预期，宁可报错让前端引导去下载模型。
    LocalModelNotSelected,
}

impl BackendDispatchError {
    /// 稳定错误码字符串：前端 humanizeSttError 按这个串路由。
    pub fn code(&self) -> &'static str {
        match self {
            BackendDispatchError::ProviderNotConfigured { .. } => "byok_provider_not_configured",
            BackendDispatchError::MissingCredentials { .. } => "byok_missing_credentials",
            BackendDispatchError::KeyringError(_) => "byok_keyring_error",
            BackendDispatchError::LocalModelNotSelected => "local_model_not_selected",
        }
    }

    /// 上层是否应当悄悄 fallback 到 SaaS 而不是把错误抛给用户。
    pub fn should_fallback_to_saas(&self) -> bool {
        matches!(self, BackendDispatchError::ProviderNotConfigured { .. })
    }
}

impl std::fmt::Display for BackendDispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackendDispatchError::ProviderNotConfigured { provider_id } => match provider_id {
                Some(id) => write!(f, "byok_provider_not_configured: provider={id}"),
                None => write!(f, "byok_provider_not_configured"),
            },
            BackendDispatchError::MissingCredentials { provider_id } => match provider_id {
                Some(id) => write!(f, "byok_missing_credentials: provider={id}"),
                None => write!(f, "byok_missing_credentials"),
            },
            BackendDispatchError::KeyringError(msg) => write!(f, "byok_keyring_error: {msg}"),
            BackendDispatchError::LocalModelNotSelected => f.write_str("local_model_not_selected"),
        }
    }
}

impl std::error::Error for BackendDispatchError {}

impl From<BackendDispatchError> for String {
    fn from(e: BackendDispatchError) -> Self {
        e.to_string()
    }
}

pub fn dispatch(
    provider_ref: &ProviderRef,
    modality: DictationModality,
) -> Result<DictationBackend, BackendDispatchError> {
    match provider_ref.mode {
        ProviderMode::Saas => Ok(match modality {
            DictationModality::Realtime => DictationBackend::SaasRealtime,
            DictationModality::File => DictationBackend::SaasFile,
        }),
        ProviderMode::Local => {
            // 只解析选择；模型是否已安装在 acquire 引擎时校验（local_model_not_installed）。
            let model_id = provider_ref
                .local_model_id
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or(BackendDispatchError::LocalModelNotSelected)?;
            Ok(match modality {
                DictationModality::Realtime => DictationBackend::LocalRealtime { model_id },
                DictationModality::File => DictationBackend::LocalFile { model_id },
            })
        }
        ProviderMode::Custom => {
            let provider_id = provider_ref
                .active_custom_provider_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or(BackendDispatchError::ProviderNotConfigured { provider_id: None })?;
            let vendor = provider_ref.custom_provider_vendor.ok_or(
                BackendDispatchError::ProviderNotConfigured {
                    provider_id: Some(provider_id.to_string()),
                },
            )?;
            let creds = load_dictation_provider_credentials_for_rust(provider_id)
                .map_err(BackendDispatchError::KeyringError)?
                .ok_or(BackendDispatchError::MissingCredentials {
                    provider_id: Some(provider_id.to_string()),
                })?;
            let name = provider_ref
                .custom_provider_name
                .clone()
                .unwrap_or_else(|| provider_id.to_string());

            match (vendor, creds) {
                (
                    CustomVendor::Tencent,
                    DictationCredentials::Tencent {
                        secret_id,
                        secret_key,
                    },
                ) => {
                    let app_id = provider_ref
                        .tencent_app_id
                        .clone()
                        .filter(|s| !s.is_empty())
                        .ok_or(BackendDispatchError::MissingCredentials {
                            provider_id: Some(provider_id.to_string()),
                        })?;
                    let region = provider_ref
                        .tencent_region
                        .clone()
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "ap-shanghai".into());
                    Ok(match modality {
                        DictationModality::Realtime => DictationBackend::TencentRealtime {
                            app_id,
                            region,
                            secret_id,
                            secret_key,
                            name,
                        },
                        DictationModality::File => DictationBackend::TencentFile {
                            app_id,
                            region,
                            secret_id,
                            secret_key,
                            name,
                            cos_bucket: provider_ref
                                .tencent_cos_bucket
                                .clone()
                                .filter(|s| !s.trim().is_empty()),
                        },
                    })
                }
                (CustomVendor::Aliyun, DictationCredentials::Aliyun { api_key }) => {
                    Ok(match modality {
                        DictationModality::Realtime => {
                            DictationBackend::AliyunRealtime { api_key, name }
                        }
                        DictationModality::File => DictationBackend::AliyunFile { api_key, name },
                    })
                }
                // vendor 与 keyring 里 JSON 的 vendor 对不上：当作凭证缺失，
                // 提示用户重新填写——比"内部错误"更可操作。
                _ => Err(BackendDispatchError::MissingCredentials {
                    provider_id: Some(provider_id.to_string()),
                }),
            }
        }
    }
}

/// 与前端 ProviderKind 字面量、history.provider_kind 列对齐。
pub fn provider_kind_str(b: &DictationBackend) -> &'static str {
    match b {
        DictationBackend::SaasRealtime => "saas-realtime",
        DictationBackend::SaasFile => "saas-file",
        DictationBackend::TencentRealtime { .. } => "tencent-realtime",
        DictationBackend::TencentFile { .. } => "tencent-file",
        DictationBackend::AliyunRealtime { .. } => "aliyun-realtime",
        DictationBackend::AliyunFile { .. } => "aliyun-file",
        DictationBackend::LocalRealtime { .. } => "local-realtime",
        DictationBackend::LocalFile { .. } => "local-file",
    }
}

/// PR-3 占位错文案：腾讯 / 阿里 BYOK 真实现还没合入。
pub const ERR_BYOK_NOT_IMPLEMENTED: &str = "byok_not_implemented_yet";

/// 旧 settings 没填 COS 桶时直接拒绝转写，不再 base64 兜底。
pub const ERR_TENCENT_COS_BUCKET_REQUIRED: &str = "tencent_cos_bucket_required";

#[cfg(test)]
mod tests {
    use super::*;

    fn pr_saas() -> ProviderRef {
        ProviderRef {
            mode: ProviderMode::Saas,
            active_custom_provider_id: None,
            custom_provider_vendor: None,
            tencent_app_id: None,
            tencent_region: None,
            tencent_cos_bucket: None,
            custom_provider_name: None,
            local_model_id: None,
        }
    }

    #[test]
    fn saas_dispatch_realtime_and_file() {
        let r = dispatch(&pr_saas(), DictationModality::Realtime).unwrap();
        assert_eq!(provider_kind_str(&r), "saas-realtime");
        let r = dispatch(&pr_saas(), DictationModality::File).unwrap();
        assert_eq!(provider_kind_str(&r), "saas-file");
    }

    #[test]
    fn custom_without_active_id_returns_not_configured() {
        let pr = ProviderRef {
            mode: ProviderMode::Custom,
            active_custom_provider_id: None,
            custom_provider_vendor: Some(CustomVendor::Tencent),
            tencent_app_id: Some("123".into()),
            tencent_region: None,
            tencent_cos_bucket: None,
            custom_provider_name: None,
            local_model_id: None,
        };
        let err = dispatch(&pr, DictationModality::Realtime).unwrap_err();
        assert_eq!(err.code(), "byok_provider_not_configured");
        assert!(err.should_fallback_to_saas());
    }

    #[test]
    fn custom_without_vendor_returns_not_configured() {
        let pr = ProviderRef {
            mode: ProviderMode::Custom,
            active_custom_provider_id: Some("p1".into()),
            custom_provider_vendor: None,
            tencent_app_id: None,
            tencent_region: None,
            tencent_cos_bucket: None,
            custom_provider_name: None,
            local_model_id: None,
        };
        let err = dispatch(&pr, DictationModality::Realtime).unwrap_err();
        assert_eq!(err.code(), "byok_provider_not_configured");
        assert!(err.should_fallback_to_saas());
    }

    #[test]
    fn provider_ref_deserialize_includes_cos_bucket() {
        let json = r#"{"mode":"custom","activeCustomProviderId":"p1","customProviderVendor":"tencent","tencentAppId":"123","tencentRegion":"ap-shanghai","tencentCosBucket":"myaudio-1234567890"}"#;
        let pr: ProviderRef = serde_json::from_str(json).unwrap();
        assert_eq!(pr.tencent_cos_bucket.as_deref(), Some("myaudio-1234567890"));
    }

    #[test]
    fn provider_ref_missing_cos_bucket_field_defaults_to_none() {
        // 老 v13 数据（缺 tencentCosBucket）必须仍能反序列化
        let json = r#"{"mode":"custom","activeCustomProviderId":"p1","customProviderVendor":"tencent","tencentAppId":"123","tencentRegion":"ap-shanghai"}"#;
        let pr: ProviderRef = serde_json::from_str(json).unwrap();
        assert!(pr.tencent_cos_bucket.is_none());
    }

    #[test]
    fn provider_ref_deserialize_camel_case() {
        let json = r#"{"mode":"custom","activeCustomProviderId":"p1","customProviderVendor":"tencent","tencentAppId":"123","tencentRegion":"ap-shanghai"}"#;
        let pr: ProviderRef = serde_json::from_str(json).unwrap();
        assert!(matches!(pr.mode, ProviderMode::Custom));
        assert_eq!(pr.active_custom_provider_id.as_deref(), Some("p1"));
        assert!(matches!(
            pr.custom_provider_vendor,
            Some(CustomVendor::Tencent)
        ));
    }

    #[test]
    fn provider_kind_strs_match_history_column() {
        // 防御性：若哪个 vendor-realtime 字符串改了，会让 history.provider_kind
        // 旧记录与新记录无法在 i18n 文案上对得上。
        assert_eq!(
            provider_kind_str(&DictationBackend::SaasRealtime),
            "saas-realtime"
        );
        assert_eq!(provider_kind_str(&DictationBackend::SaasFile), "saas-file");
    }

    fn local_ref(model_id: Option<&str>) -> ProviderRef {
        ProviderRef {
            local_model_id: model_id.map(str::to_string),
            mode: ProviderMode::Local,
            ..pr_saas()
        }
    }

    #[test]
    fn local_mode_dispatches_to_local_backends() {
        let r = local_ref(Some("xasr"));
        assert!(matches!(
            dispatch(&r, DictationModality::Realtime),
            Ok(DictationBackend::LocalRealtime { ref model_id }) if model_id == "xasr"
        ));
        let file = dispatch(&r, DictationModality::File).unwrap();
        assert_eq!(provider_kind_str(&file), "local-file");
    }

    // 用户明确选了离线：没选模型时必须报错，绝不能悄悄 fallback 把录音送上云。
    #[test]
    fn local_mode_without_model_never_falls_back_to_saas() {
        for id in [None, Some("")] {
            let err = dispatch(&local_ref(id), DictationModality::Realtime).unwrap_err();
            assert_eq!(err.code(), "local_model_not_selected");
            assert!(!err.should_fallback_to_saas());
        }
    }

    #[test]
    fn provider_ref_accepts_local_mode_json() {
        let r: ProviderRef =
            serde_json::from_str(r#"{"mode":"local","localModelId":"xasr"}"#).unwrap();
        assert!(matches!(r.mode, ProviderMode::Local));
        assert_eq!(r.local_model_id.as_deref(), Some("xasr"));
    }
}
