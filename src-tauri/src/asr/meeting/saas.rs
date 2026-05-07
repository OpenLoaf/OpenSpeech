// SaaS 实时 ASR provider（OpenLoaf 端 OL-TL-RT-003，腾讯上游 16k_zh_en_speaker）。
//
// **为什么不直接用 SDK 0.3.17 的 `RealtimeAsrSession`**：
//   SDK 0.3.17 changelog 声称 `RealtimePartialFrame` / `RealtimeFinalFrame` 已加
//   `speaker_id`，但 Rust 端这一版只更新了 changelog，source 里 `RealtimeEvent`
//   enum 仍只有 `sentence_id` + `text`——服务端推过来的 `speakerId` 字段被 serde
//   忽略落到地板上，前端永远拿不到说话人分离结果。
//
//   等 SDK 把字段补齐后，本文件可以整体回退到包装 `RealtimeAsrSession`（删掉
//   raw WS worker，map_event 加上 speaker_id 透出即可）。
//
// 协议：参考 ~/.agents/skills/openloaf-saas-sdk/tools/OL-TL-RT-003-realtime-asr.md
//   - URL: `wss://{base}/api/ai/v4/tools/OL-TL-RT-003/stream?token=<bearer>`
//   - 客户端首帧 `{"type":"start","params":{...}}` —— 引擎 `16k_zh_en_speaker`
//   - 后续二进制帧 = PCM16 LE / 16 kHz / mono / 100 ms/frame
//   - 服务端推 `ready` / `partial` / `final` / `credits` / `error` / `closed`
//   - 字段全 camelCase（`sentenceId` / `speakerId` / `beginMs` / `endMs`）

use std::io::ErrorKind as IoErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use openloaf_saas::SaaSClient;
use serde::Deserialize;
use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use url::Url;

use super::provider::{
    MeetingAsrProvider, MeetingEvent, MeetingProviderCapabilities, MeetingProviderError,
    MeetingSegment, MeetingSession, MeetingSessionConfig,
};

pub const PROVIDER_ID: &str = "saas";

/// 16k_zh_en_speaker 大模型自带中英 + 多方言识别 + 说话人分离。
/// language 字段不传给上游——只用于前端 UI 校验。
pub const SUPPORTED_LANGUAGES: &[&str] = &[
    "zh", "en", "yue", "sc", "sx", "hn", "sh", "xn", "hb", "ah",
];

const ENGINE_MODEL_TYPE: &str = "16k_zh_en_speaker";
const VARIANT_ID: &str = "OL-TL-RT-003";
const READ_POLL_INTERVAL: Duration = Duration::from_millis(5);
const WS_LOG_TARGET: &str = "openspeech::asr::meeting::saas";

// ---------- Provider 实例 ----------

pub struct SaasMeetingProvider {
    client: SaaSClient,
    base_url: String,
}

impl SaasMeetingProvider {
    pub fn new(client: SaaSClient, base_url: impl Into<String>) -> Self {
        Self {
            client,
            base_url: base_url.into(),
        }
    }
}

impl MeetingAsrProvider for SaasMeetingProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> MeetingProviderCapabilities {
        MeetingProviderCapabilities {
            speaker_diarization: true,
            supported_languages: SUPPORTED_LANGUAGES,
            // OL-TL-RT-003 服务端 60s 无音频帧主动断开（idle_timeout）。
            max_idle_silence_ms: 60_000,
            recommended_chunk_ms: 100,
            sample_rate: 16_000,
        }
    }

    fn open(
        &self,
        config: MeetingSessionConfig,
    ) -> Result<Box<dyn MeetingSession>, MeetingProviderError> {
        if !config.enable_diarization {
            return Err(MeetingProviderError::Unsupported(
                "saas RT-003 16k_zh_en_speaker always returns speakerId; \
                 set enable_diarization=true"
                    .into(),
            ));
        }
        if !SUPPORTED_LANGUAGES.contains(&config.language.as_str()) {
            return Err(MeetingProviderError::Unsupported(format!(
                "language `{}` not supported by SaaS RT-003 16k_zh_en_speaker",
                config.language
            )));
        }
        let token = self
            .client
            .access_token()
            .ok_or_else(|| MeetingProviderError::Unauthenticated(
                "saas access_token missing (not signed in)".into(),
            ))?;
        SaasMeetingSession::connect(&self.base_url, &token).map(|s| Box::new(s) as Box<dyn MeetingSession>)
    }
}

// ---------- 会话实现 ----------

pub struct SaasMeetingSession {
    outbox: Sender<Outbound>,
    inbox: Receiver<SessionRaw>,
    worker: Option<JoinHandle<()>>,
}

enum Outbound {
    Binary(Vec<u8>),
    /// 主动 `{type:finish}` 通知服务端拉完最后一句。
    Finish,
    Close,
}

enum SessionRaw {
    Event(MeetingEvent),
    Network(String),
}

impl SaasMeetingSession {
    fn connect(base_url: &str, token: &str) -> Result<Self, MeetingProviderError> {
        let url = build_ws_url(base_url, VARIANT_ID, token)
            .map_err(|e| MeetingProviderError::BadConfig(e.to_string()))?;
        log::info!(target: WS_LOG_TARGET, "[ws-connect] saas {VARIANT_ID} engine={ENGINE_MODEL_TYPE}");

        let request = url
            .as_str()
            .into_client_request()
            .map_err(|e| MeetingProviderError::BadConfig(e.to_string()))?;
        let (mut ws, resp) = tungstenite::connect(request)
            .map_err(|e| MeetingProviderError::Network(e.to_string()))?;
        log::debug!(
            target: WS_LOG_TARGET,
            "[ws-debug] http_upgrade_response status={}",
            resp.status()
        );

        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => s
                .set_nonblocking(true)
                .map_err(|e| MeetingProviderError::Network(e.to_string()))?,
            MaybeTlsStream::Rustls(s) => s
                .get_mut()
                .set_nonblocking(true)
                .map_err(|e| MeetingProviderError::Network(e.to_string()))?,
            _ => {}
        }

        // start 帧——固定走 16k_zh_en_speaker，需要其它引擎时再考虑外露 params。
        let start = serde_json::json!({
            "type": "start",
            "params": {
                "engine_model_type": ENGINE_MODEL_TYPE,
                "voice_format": 1,
                "needvad": 1,
                "convert_num_mode": 1,
            },
        });
        ws.send(Message::Text(start.to_string()))
            .map_err(|e| MeetingProviderError::Network(format!("send start: {e}")))?;
        let _ = ws.flush();

        let (outbox_tx, outbox_rx) = mpsc::channel::<Outbound>();
        let (inbox_tx, inbox_rx) = mpsc::channel::<SessionRaw>();
        let worker = thread::Builder::new()
            .name("openspeech-saas-meeting".into())
            .spawn(move || run_worker(ws, outbox_rx, inbox_tx))
            .map_err(|e| MeetingProviderError::Network(format!("spawn worker: {e}")))?;

        Ok(Self {
            outbox: outbox_tx,
            inbox: inbox_rx,
            worker: Some(worker),
        })
    }
}

impl MeetingSession for SaasMeetingSession {
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String> {
        self.outbox
            .send(Outbound::Binary(pcm16))
            .map_err(|_| "session closed".into())
    }

    fn finish(&mut self) -> Result<(), String> {
        self.outbox
            .send(Outbound::Finish)
            .map_err(|_| "session closed".into())
    }

    fn next_event(&mut self, dur: Duration) -> MeetingEvent {
        match self.inbox.recv_timeout(dur) {
            Ok(SessionRaw::Event(ev)) => ev,
            Ok(SessionRaw::Network(m)) => MeetingEvent::NetworkExit(m),
            Err(RecvTimeoutError::Timeout) => MeetingEvent::Idle,
            Err(RecvTimeoutError::Disconnected) => MeetingEvent::NetworkExit("worker gone".into()),
        }
    }
}

impl Drop for SaasMeetingSession {
    fn drop(&mut self) {
        let _ = self.outbox.send(Outbound::Close);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

// ---------- WebSocket worker ----------

fn build_ws_url(base_url: &str, variant_id: &str, token: &str) -> Result<Url, String> {
    let mut base = Url::parse(base_url).map_err(|e| format!("invalid base_url: {e}"))?;
    let new_scheme = match base.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => return Err(format!("unsupported scheme: {other}")),
    };
    base.set_scheme(new_scheme).map_err(|_| "scheme change failed".to_string())?;
    base.set_path(&format!("/api/ai/v4/tools/{variant_id}/stream"));
    base.query_pairs_mut().clear().append_pair("token", token);
    Ok(base)
}

fn run_worker(
    mut ws: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    outbox_rx: Receiver<Outbound>,
    inbox_tx: Sender<SessionRaw>,
) {
    loop {
        let mut should_break = false;
        loop {
            match outbox_rx.try_recv() {
                Ok(Outbound::Binary(bytes)) => {
                    log::trace!(
                        target: WS_LOG_TARGET,
                        "[ws-out] saas audio binary {}B",
                        bytes.len(),
                    );
                    if let Err(e) = ws.send(Message::Binary(bytes)) {
                        if !is_would_block(&e) {
                            let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                            return;
                        }
                    }
                }
                Ok(Outbound::Finish) => {
                    log::debug!(target: WS_LOG_TARGET, "[ws-out] saas {{\"type\":\"finish\"}}");
                    if let Err(e) = ws.send(Message::Text("{\"type\":\"finish\"}".into())) {
                        if !is_would_block(&e) {
                            let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                            return;
                        }
                    }
                }
                Ok(Outbound::Close) => {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    should_break = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    should_break = true;
                    break;
                }
            }
        }
        if should_break {
            return;
        }

        if let Err(e) = ws.flush() {
            if !is_would_block(&e) {
                let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                return;
            }
        }

        match ws.read() {
            Ok(Message::Text(s)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] saas text raw: {s}");
                match parse_frame(&s) {
                    Ok(Some(ev)) => {
                        let terminal = matches!(
                            ev,
                            MeetingEvent::Error { .. } | MeetingEvent::EndOfStream
                        );
                        if inbox_tx.send(SessionRaw::Event(ev)).is_err() {
                            return;
                        }
                        if terminal {
                            let _ = ws.close(None);
                            let _ = ws.flush();
                            return;
                        }
                    }
                    Ok(None) => {} // credits 等无关帧，吞掉
                    Err(e) => {
                        let _ = inbox_tx
                            .send(SessionRaw::Event(MeetingEvent::DecodeRecoverable(e)));
                    }
                }
            }
            Ok(Message::Binary(b)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] saas binary {}B", b.len());
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(Message::Close(frame)) => {
                log::info!(target: WS_LOG_TARGET, "[ws-in] saas close frame: {frame:?}");
                return;
            }
            Ok(Message::Frame(_)) => return,
            Err(e) if is_would_block(&e) => {
                thread::sleep(READ_POLL_INTERVAL);
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return;
            }
            Err(e) => {
                log::warn!(target: WS_LOG_TARGET, "[ws-err] saas {e}");
                let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                return;
            }
        }
    }
}

fn is_would_block(err: &tungstenite::Error) -> bool {
    matches!(err, tungstenite::Error::Io(e) if e.kind() == IoErrorKind::WouldBlock)
}

// ---------- Frame parser ----------
//
// 服务端 wire format 全是 camelCase。`speakerId` 在 16k_zh_en_speaker 引擎下才会
// 推送（其它引擎不带），所以 default_speaker_id() 默认 -1（待识别）。

// Credits.remaining_credits / Closed.reason 字段保留是为了未来日志或 UI 展示用，
// 当前不读取——加 allow(dead_code) 而不是删字段，避免后面再加回来时还得对一遍 wire。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[allow(dead_code)]
enum SaasFrame {
    #[serde(rename_all = "camelCase")]
    Ready {
        #[serde(default)]
        session_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Partial {
        sentence_id: i64,
        #[serde(default)]
        text: String,
        #[serde(default = "default_speaker_id")]
        speaker_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    Final {
        sentence_id: i64,
        #[serde(default)]
        text: String,
        #[serde(default)]
        begin_ms: Option<i64>,
        #[serde(default)]
        end_ms: Option<i64>,
        #[serde(default = "default_speaker_id")]
        speaker_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    Credits {
        #[serde(default)]
        remaining_credits: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Closed {
        #[serde(default)]
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
    },
}

fn default_speaker_id() -> i32 {
    -1
}

fn parse_frame(raw: &str) -> Result<Option<MeetingEvent>, String> {
    let frame: SaasFrame = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    Ok(Some(match frame {
        SaasFrame::Ready { session_id } => MeetingEvent::Ready { session_id },
        SaasFrame::Partial {
            sentence_id,
            text,
            speaker_id,
        } => MeetingEvent::SegmentPartial(MeetingSegment {
            sentence_id,
            speaker_id,
            text,
            start_ms: 0,
            end_ms: 0,
        }),
        SaasFrame::Final {
            sentence_id,
            text,
            begin_ms,
            end_ms,
            speaker_id,
        } => MeetingEvent::SegmentFinal(MeetingSegment {
            sentence_id,
            speaker_id,
            text,
            start_ms: begin_ms.unwrap_or(0).max(0) as u64,
            end_ms: end_ms.unwrap_or(0).max(0) as u64,
        }),
        SaasFrame::Closed { .. } => MeetingEvent::EndOfStream,
        SaasFrame::Error { code, message } => MeetingEvent::Error {
            code: classify_saas_code(&code),
            message,
        },
        SaasFrame::Credits { .. } => return Ok(None),
    }))
}

fn classify_saas_code(code: &str) -> String {
    match code {
        "auth_failure" => "unauthenticated_saas".into(),
        "insufficient_credits" => "insufficient_funds_saas".into(),
        "idle_timeout" => "idle_timeout".into(),
        "max_duration" => "max_duration".into(),
        "upstream_error" => "upstream_error".into(),
        other => format!("saas_{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ready_frame() {
        let raw = r#"{"type":"ready","sessionId":"abc","startedAt":123}"#;
        match parse_frame(raw).unwrap().unwrap() {
            MeetingEvent::Ready { session_id } => {
                assert_eq!(session_id.as_deref(), Some("abc"));
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn parse_partial_with_speaker_id() {
        let raw = r#"{"type":"partial","sentenceId":7,"text":"hello","speakerId":1}"#;
        match parse_frame(raw).unwrap().unwrap() {
            MeetingEvent::SegmentPartial(s) => {
                assert_eq!(s.sentence_id, 7);
                assert_eq!(s.speaker_id, 1);
                assert_eq!(s.text, "hello");
            }
            other => panic!("expected SegmentPartial, got {other:?}"),
        }
    }

    #[test]
    fn parse_partial_without_speaker_id_defaults_minus_one() {
        let raw = r#"{"type":"partial","sentenceId":3,"text":"hi"}"#;
        match parse_frame(raw).unwrap().unwrap() {
            MeetingEvent::SegmentPartial(s) => assert_eq!(s.speaker_id, -1),
            other => panic!("expected SegmentPartial, got {other:?}"),
        }
    }

    #[test]
    fn parse_final_with_timing_and_speaker() {
        let raw = r#"{"type":"final","sentenceId":2,"text":"world","beginMs":1000,"endMs":2200,"speakerId":0}"#;
        match parse_frame(raw).unwrap().unwrap() {
            MeetingEvent::SegmentFinal(s) => {
                assert_eq!(s.start_ms, 1000);
                assert_eq!(s.end_ms, 2200);
                assert_eq!(s.speaker_id, 0);
            }
            other => panic!("expected SegmentFinal, got {other:?}"),
        }
    }

    #[test]
    fn parse_credits_frame_returns_none() {
        let raw = r#"{"type":"credits","remainingCredits":12.5}"#;
        assert!(parse_frame(raw).unwrap().is_none());
    }

    #[test]
    fn parse_closed_to_end_of_stream() {
        let raw = r#"{"type":"closed","reason":"client_finish","totalSeconds":42.3}"#;
        assert!(matches!(parse_frame(raw).unwrap().unwrap(), MeetingEvent::EndOfStream));
    }

    #[test]
    fn parse_error_classifies_code() {
        let raw = r#"{"type":"error","code":"insufficient_credits","message":"no balance"}"#;
        match parse_frame(raw).unwrap().unwrap() {
            MeetingEvent::Error { code, .. } => assert_eq!(code, "insufficient_funds_saas"),
            other => panic!("expected Error, got {other:?}"),
        }
    }
}

