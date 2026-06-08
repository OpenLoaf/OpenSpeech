// ASR → AI refine 的 Rust 内部串联。
//
// 为什么存在：主窗失焦时 macOS WebKit 节流主窗 webview 的 event loop，前端
// `await invoke(transcribe)` 的 IPC response 投递被卡几秒到几分钟，导致「ASR
// 出结果 → 前端再 invoke refine」这一跳长时间停摆。把这一跳搬到 Rust 内部：
// 一次 invoke 跑完 ASR + refine，最终结果由 Rust 直接写系统剪贴板兜底（不经
// webview，不受节流），保证文字一定落地。
//
// refine 的 delta 仍通过 run_refine_core 内部的 EVENT_DELTA emit；前端监听不变。
// 前台时流式注入照常，后台时这些回调同样被节流退化——剪贴板兜底是后台的落地保证。

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::ai_refine::{RefineChatInput, run_refine_core};
use crate::asr::byok::ProviderRef;
use crate::transcribe::transcribe_recording_file;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAndRefineResult {
    pub raw_text: String,
    pub refined_text: Option<String>,
    pub asr_variant: String,
    pub provider_kind: String,
    pub credits_asr: f64,
    pub credits_refine: f64,
    /// 分阶段错误码（稳定串，前端按现有 isSaasAuthError / humanizeSttError 路由）。
    pub asr_error: Option<String>,
    pub refine_error: Option<String>,
    pub clipboard_written: bool,
}

#[tauri::command]
pub async fn transcribe_and_refine<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    duration_ms: u64,
    lang: Option<String>,
    provider: Option<ProviderRef>,
    asr_system_prompt: Option<String>,
    // None = 只转写不 refine（等价 skip-refine / refine 关闭）。user_text 由本命令
    // 用 ASR 输出填充，前端传空串占位即可。
    refine: Option<RefineChatInput>,
    clipboard_fallback: bool,
) -> Result<TranscribeAndRefineResult, String> {
    // 1. ASR：直接复用现有命令函数，自动走完整 dispatch + 全 backend + fallback。
    let asr = transcribe_recording_file(
        app.clone(),
        audio_path,
        duration_ms,
        lang,
        provider,
        asr_system_prompt,
    )
    .await;
    let (raw_text, asr_variant, provider_kind, credits_asr) = match asr {
        Ok(r) => (
            crate::text_normalize::normalize_asr_punctuation(&r.text),
            r.variant,
            r.provider_kind,
            r.credits_consumed,
        ),
        Err(e) => {
            log::warn!("[transcribe_and_refine] ASR failed: {e}");
            return Ok(TranscribeAndRefineResult {
                raw_text: String::new(),
                refined_text: None,
                asr_variant: String::new(),
                provider_kind: String::new(),
                credits_asr: 0.0,
                credits_refine: 0.0,
                asr_error: Some(e),
                refine_error: None,
                clipboard_written: false,
            });
        }
    };

    // 静音 / 空转写：没内容可 refine，也不写剪贴板（不覆盖用户已有剪贴板）。
    if raw_text.trim().is_empty() {
        return Ok(TranscribeAndRefineResult {
            raw_text,
            refined_text: None,
            asr_variant,
            provider_kind,
            credits_asr,
            credits_refine: 0.0,
            asr_error: None,
            refine_error: None,
            clipboard_written: false,
        });
    }

    // 2. refine（若启用）。失败时 refined_text 留 None，落地用 raw_text 兜底。
    let mut refined_text: Option<String> = None;
    let mut refine_error: Option<String> = None;
    let mut credits_refine = 0.0;
    if let Some(mut input) = refine {
        input.user_text = raw_text.clone();
        match run_refine_core(app.clone(), input).await {
            Ok(rr) => {
                refined_text = Some(rr.refined_text);
                credits_refine = rr.credits_consumed;
            }
            Err(e) => {
                log::warn!("[transcribe_and_refine] refine failed: {e}");
                refine_error = Some(e);
            }
        }
    }

    // 3. 落地兜底：最终文本写系统剪贴板。Rust 直写，不经被节流的 webview。
    let landing_text = refined_text.clone().unwrap_or_else(|| raw_text.clone());
    let mut clipboard_written = false;
    if clipboard_fallback && !landing_text.is_empty() {
        match app.clipboard().write_text(landing_text) {
            Ok(()) => clipboard_written = true,
            Err(e) => log::warn!("[transcribe_and_refine] clipboard write failed: {e}"),
        }
    }

    log::info!(
        "[transcribe_and_refine] done raw_len={} refined={} clipboard_written={} credits_asr={} credits_refine={}",
        raw_text.chars().count(),
        refined_text
            .as_ref()
            .map(|s| s.chars().count())
            .unwrap_or(0),
        clipboard_written,
        credits_asr,
        credits_refine,
    );

    Ok(TranscribeAndRefineResult {
        raw_text,
        refined_text,
        asr_variant,
        provider_kind,
        credits_asr,
        credits_refine,
        asr_error: None,
        refine_error,
        clipboard_written,
    })
}
