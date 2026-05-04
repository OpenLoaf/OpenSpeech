// E2E 集成测试：直接打到真腾讯/阿里云，验证 BYOK 链路从凭证读取 → 网络
// 调用 → 结果解析的完整闭环。
//
// 默认不跑（每条用例都 `#[ignore]`），按需触发：
//
//   cd src-tauri
//   cargo test --lib asr::byok_e2e -- --ignored --nocapture --test-threads=1
//
// 依赖：
// - macOS Keychain service "com.openspeech.app" 里有 dictation_provider_<id> 条目
// - ~/Library/Application Support/com.openspeech.app/settings.json 里有
//   dictation.customProviders 描述 (id / vendor / tencentAppId / tencentRegion)
// - ~/Library/Application Support/com.openspeech.app/recordings/ 至少一个 .ogg
//
// 第一次跑时 macOS 会弹"cargo / test binary 想读取 keychain 条目"——选「始终允许」。

#![cfg(test)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::asr::aliyun::file::{
    DashScopeClient, ReqwestDashScopeClient, TaskStatus as AliyunTaskStatus,
    TokioSleeper as AliyunSleeper, merge_transcripts_payload, poll_task_until_terminal,
};
use crate::asr::aliyun::oss_upload::{BailianOssClient, ReqwestBailianOssClient};
use crate::asr::tencent::file::{
    AudioSource, CreateRecTaskRequest, ReqwestHttp, TokioSleeper as TencentSleeper,
    merge_result_detail, poll_until_terminal, submit_create_task,
};
use crate::secrets::{DictationCredentials, load_dictation_provider_credentials_for_rust};

// ─── settings.json 解析 ───────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct PersistRoot {
    root: PersistInner,
}

#[derive(Debug, Deserialize)]
struct PersistInner {
    dictation: DictationSlice,
}

#[derive(Debug, Deserialize)]
struct DictationSlice {
    #[serde(default, rename = "activeCustomProviderId")]
    _active_custom_provider_id: Option<String>,
    #[serde(rename = "customProviders")]
    custom_providers: Vec<ProviderEntry>,
}

#[derive(Debug, Deserialize, Clone)]
struct ProviderEntry {
    id: String,
    name: String,
    vendor: String,
    #[serde(rename = "tencentAppId", default)]
    tencent_app_id: Option<String>,
    #[serde(rename = "tencentRegion", default)]
    tencent_region: Option<String>,
}

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME env var must be set");
    PathBuf::from(home).join("Library/Application Support/com.openspeech.app")
}

fn load_settings() -> PersistInner {
    let path = config_dir().join("settings.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let parsed: PersistRoot = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse settings.json: {e}"));
    parsed.root
}

fn pick_provider(vendor: &str) -> ProviderEntry {
    let s = load_settings();
    s.dictation
        .custom_providers
        .into_iter()
        .find(|p| p.vendor == vendor)
        .unwrap_or_else(|| {
            panic!("no custom provider with vendor={vendor} in settings.json")
        })
}

fn load_creds(provider_id: &str) -> DictationCredentials {
    load_dictation_provider_credentials_for_rust(provider_id)
        .unwrap_or_else(|e| panic!("keychain read for {provider_id}: {e}"))
        .unwrap_or_else(|| {
            panic!(
                "no keychain entry for dictation_provider_{provider_id} \
                 (service=com.openspeech.app); \
                 配置好供应商但凭证没存？"
            )
        })
}

// ─── 录音文件挑选 ─────────────────────────────────────────────────

fn pick_latest_ogg() -> PathBuf {
    let root = config_dir().join("recordings");
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    let day_dirs = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read {}: {e}", root.display()));
    for day in day_dirs {
        let day_path = day.expect("dir entry").path();
        if !day_path.is_dir() {
            continue;
        }
        for f in std::fs::read_dir(&day_path).expect("read day dir") {
            let p = f.expect("dir entry").path();
            if p.extension().and_then(|s| s.to_str()) != Some("ogg") {
                continue;
            }
            let mtime = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .expect("mtime");
            match &newest {
                Some((cur, _)) if *cur >= mtime => {}
                _ => newest = Some((mtime, p)),
            }
        }
    }
    newest
        .map(|(_, p)| p)
        .expect("no .ogg under recordings/<day>/; 先按一次快捷键录一段")
}

// ─── 阶段 0：凭证 / 配置 sanity ───────────────────────────────────

#[test]
#[ignore]
fn stage_0a_settings_loaded_and_dictation_in_custom_mode() {
    let s = load_settings();
    eprintln!("custom providers: {} 条", s.dictation.custom_providers.len());
    for p in &s.dictation.custom_providers {
        eprintln!(
            "  - id={} vendor={} name={} appId={:?} region={:?}",
            p.id, p.vendor, p.name, p.tencent_app_id, p.tencent_region
        );
    }
    assert!(
        !s.dictation.custom_providers.is_empty(),
        "settings.dictation.customProviders 为空——先在 UI 里加一个供应商"
    );
}

#[test]
#[ignore]
fn stage_0b_keychain_returns_credentials_for_each_provider() {
    let s = load_settings();
    for p in &s.dictation.custom_providers {
        let creds = load_creds(&p.id);
        match creds {
            DictationCredentials::Tencent { secret_id, .. } => eprintln!(
                "✓ {} (tencent) secretId 长度 {}（前 4 位 {}…）",
                p.name,
                secret_id.len(),
                &secret_id[..secret_id.len().min(4)]
            ),
            DictationCredentials::Aliyun { api_key } => eprintln!(
                "✓ {} (aliyun) apiKey 长度 {}（前 6 位 {}…）",
                p.name,
                api_key.len(),
                &api_key[..api_key.len().min(6)]
            ),
        }
    }
}

// ─── 阶段 1：凭证打到云端但不做完整业务（快速失败） ─────────────

/// 提交一个一定会失败但**鉴权能过**的小请求：
/// CreateRecTask 用 1 秒静音 PCM/WAV，期望要么拿到 task_id（鉴权 ok）
/// 要么 AuthFailure（密钥错）。本测试只关心鉴权链路，不等转写结果。
#[tokio::test]
#[ignore]
async fn stage_1_tencent_credentials_pass_signature_check() {
    let p = pick_provider("tencent");
    let DictationCredentials::Tencent { secret_id, secret_key } = load_creds(&p.id) else {
        panic!("provider {} marked tencent but keychain JSON vendor mismatch", p.id);
    };
    let region = p.tencent_region.as_deref().unwrap_or("ap-shanghai").to_string();

    // 一段 320 字节的"假音频"——鉴权阶段拒不到这里；
    // 即便鉴权过、走到业务层，也会因为太短被拒，这里同样接受。
    let dummy = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8; 320]);
    let req = CreateRecTaskRequest::new_local(dummy, 320).engine("16k_zh");
    let http = ReqwestHttp::new().expect("build reqwest client");
    let res = submit_create_task(&http, &secret_id, &secret_key, Some(&region), &req).await;
    match res {
        Ok(task_id) => eprintln!("✓ 腾讯鉴权 OK，拿到 task_id={task_id}"),
        Err(e) => {
            let msg = e.to_string();
            assert!(
                !msg.contains("tencent_unauthenticated"),
                "腾讯鉴权失败 → SecretId / SecretKey 错: {msg}"
            );
            eprintln!(
                "腾讯鉴权 OK（业务层拒收 dummy audio 是预期的）: {msg}"
            );
        }
    }
}

#[tokio::test]
#[ignore]
async fn stage_1_aliyun_credentials_pass_get_policy() {
    let p = pick_provider("aliyun");
    let DictationCredentials::Aliyun { api_key } = load_creds(&p.id) else {
        panic!("provider {} marked aliyun but keychain JSON vendor mismatch", p.id);
    };

    let oss = ReqwestBailianOssClient::new().expect("build client");
    let policy = oss.get_policy(&api_key).await.unwrap_or_else(|e| {
        panic!("百炼 getPolicy 调用失败 → ApiKey 可能无效: {e}");
    });
    eprintln!(
        "✓ 阿里 ApiKey OK; upload_host={} key_prefix={} expire={}s",
        policy.upload_host, policy.upload_dir, policy.expire_in_seconds
    );
    assert!(!policy.upload_host.is_empty());
    assert!(!policy.policy.is_empty());
    assert!(!policy.signature.is_empty());
}

// ─── 阶段 2：完整 file 转写打通（最慢） ──────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn stage_2_tencent_file_e2e_with_local_recording() {
    let p = pick_provider("tencent");
    let DictationCredentials::Tencent { secret_id, secret_key } = load_creds(&p.id) else {
        panic!("vendor mismatch");
    };
    let region = p.tencent_region.as_deref().unwrap_or("ap-shanghai").to_string();
    let ogg_path = pick_latest_ogg();
    let bytes = std::fs::read(&ogg_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", ogg_path.display()));
    eprintln!(
        "[tencent] 提交 {} ({} bytes) → CreateRecTask",
        ogg_path.display(),
        bytes.len()
    );

    let len = bytes.len() as u64;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let req = CreateRecTaskRequest::new_local(b64, len).engine("16k_zh");
    let http = ReqwestHttp::new().expect("build client");

    let task_id = submit_create_task(&http, &secret_id, &secret_key, Some(&region), &req)
        .await
        .unwrap_or_else(|e| panic!("submit failed: {e}"));
    eprintln!("[tencent] task_id={task_id} → 轮询中…");

    let resp = poll_until_terminal(
        &http,
        &TencentSleeper,
        &secret_id,
        &secret_key,
        Some(&region),
        task_id,
        Duration::from_secs(2),
        Instant::now() + Duration::from_secs(120),
    )
    .await
    .unwrap_or_else(|e| panic!("poll failed: {e}"));

    let data = resp.response.data.expect("Success 响应必带 data");
    let text = merge_result_detail(&data.result_detail);
    let final_text = if text.is_empty() {
        eprintln!(
            "[tencent] ResultDetail 空，回退 Result 字段（带时间戳前缀）: {}",
            data.result
        );
        data.result.clone()
    } else {
        text
    };
    eprintln!("[tencent] ✓ 转写完成 (audio_duration={}s):", data.audio_duration);
    eprintln!("    {}", final_text);
    assert!(
        !final_text.trim().is_empty(),
        "转写结果为空——录音可能是静音或 Tencent 端识别失败"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn stage_2_aliyun_file_e2e_with_local_recording() {
    let p = pick_provider("aliyun");
    let DictationCredentials::Aliyun { api_key } = load_creds(&p.id) else {
        panic!("vendor mismatch");
    };
    let ogg_path = pick_latest_ogg();
    let bytes = std::fs::read(&ogg_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", ogg_path.display()));
    let file_name = ogg_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.ogg")
        .to_string();
    eprintln!(
        "[aliyun] 上传 {} ({} bytes) → 百炼 OSS",
        ogg_path.display(),
        bytes.len()
    );

    let oss = ReqwestBailianOssClient::new().expect("build oss client");
    let policy = oss
        .get_policy(&api_key)
        .await
        .unwrap_or_else(|e| panic!("getPolicy failed: {e}"));
    let oss_url = oss
        .upload_file(&policy, &file_name, bytes.clone())
        .await
        .unwrap_or_else(|e| panic!("upload failed: {e}"));
    eprintln!("[aliyun] OSS URL: {oss_url}");

    let dash = ReqwestDashScopeClient::new().expect("build dashscope client");
    let task_id = dash
        .submit_filetrans(&api_key, std::slice::from_ref(&oss_url))
        .await
        .unwrap_or_else(|e| panic!("submit_filetrans failed: {e}"));
    eprintln!("[aliyun] filetrans task_id={task_id} → 轮询中…");

    let out = poll_task_until_terminal(
        &dash,
        &AliyunSleeper,
        &api_key,
        &task_id,
        Duration::from_secs(2),
        Instant::now() + Duration::from_secs(120),
    )
    .await
    .unwrap_or_else(|e| panic!("poll failed: {e}"));

    let status = AliyunTaskStatus::from_str(&out.task_status);
    assert_eq!(
        status,
        AliyunTaskStatus::Succeeded,
        "filetrans 终态非 SUCCEEDED: {} ({:?})",
        out.task_status,
        out.message
    );

    // paraformer-v2 真转写文本在 transcription_url 指向的 OSS JSON 里——逐个 fetch
    // 拼接，与 transcribe_aliyun_file_with 的生产实现保持一致。
    let mut payloads = Vec::with_capacity(out.results.len());
    for r in &out.results {
        let Some(url) = r.transcription_url.as_deref() else {
            continue;
        };
        let payload = dash
            .fetch_transcription(url)
            .await
            .unwrap_or_else(|e| panic!("fetch_transcription failed: {e}"));
        payloads.push(payload);
    }
    let text = merge_transcripts_payload(&payloads);
    eprintln!("[aliyun] ✓ 转写完成: {text}");
    assert!(
        !text.trim().is_empty(),
        "transcription_url 拉到的 payload 里没文本（录音可能是真静音）"
    );
    let _ = bytes;
}

// 让 use 不报"未使用"——AudioSource 与一些类型在不同测试间复用。
#[allow(dead_code)]
fn _ensure_imports_alive() {
    let _ = AudioSource::Url("dummy".into());
}
