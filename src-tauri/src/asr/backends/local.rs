// 本地（离线）实时 ASR backend：把推理子进程会话适配到 RealtimeAsrBackend trait。
//
// 线程模型与云端 vendor 对齐：send_audio / finish 只往 mpsc 里投，独立 worker 线程
// 打开子进程会话、转发音频、把识别事件翻成 RealtimeBackendEvent 回给 stt worker。
//
// 会话在 worker 线程里打开（opener），不在构造时：冷启动要拉起子进程 + 加载模型
// 约 1.5s，若在 stt_start 里同步做，会话要等加载完才进 slot，这段时间麦克风的帧
// 会被 try_send_audio_pcm16 当「无会话」丢掉，开头的话就没了。现在会话立即建好，
// 加载期间音频在 cmd 通道里排队，加载完一次性灌进子进程，解码 1.5s 音频只要几十 ms。
//
// 事件时序：构造即 Ready（本地无握手）→ Partial / Final（端点检测切句，sentence_id
// 递增）→ finish 后冲刷尾句 Final → EndOfStream。stt_finalize 看到 EndOfStream
// 立即返回。加载失败 / 子进程中途退出 → Error{code}，stt worker 照常转成前端错误。

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::asr::realtime_backend::{RealtimeAsrBackend, RealtimeBackendEvent};
use crate::local_asr::error::LocalAsrError;
use crate::local_asr::host::StreamSession;
use crate::local_asr::host::protocol::Event;

/// 在 worker 线程里打开识别会话（命中常驻子进程即时返回，冷启动阻塞约 1.5s）。
pub type SessionOpener = Box<dyn FnOnce() -> Result<Box<dyn StreamSession>, LocalAsrError> + Send>;

/// worker 轮询子进程事件的间隔；期间积压的音频下一轮一次性转发。
const POLL: Duration = Duration::from_millis(10);

enum Command {
    Audio(Vec<f32>),
    Finish,
}

pub struct LocalRealtimeBackend {
    cmd_tx: Option<Sender<Command>>,
    event_rx: Receiver<RealtimeBackendEvent>,
    worker: Option<JoinHandle<()>>,
}

impl LocalRealtimeBackend {
    pub fn new(opener: SessionOpener) -> Result<Self, String> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (event_tx, event_rx) = mpsc::channel::<RealtimeBackendEvent>();
        let _ = event_tx.send(RealtimeBackendEvent::Ready { session_id: None });
        let worker = std::thread::Builder::new()
            .name("openspeech-local-asr".into())
            .spawn(move || match opener() {
                Ok(session) => relay_loop(session, cmd_rx, event_tx),
                Err(e) => {
                    log::warn!("[local_asr] open session failed: {e}");
                    send_error(&event_tx, &e);
                }
            })
            .map_err(|e| format!("spawn local asr worker: {e}"))?;
        Ok(Self {
            cmd_tx: Some(cmd_tx),
            event_rx,
            worker: Some(worker),
        })
    }
}

fn send_error(event_tx: &Sender<RealtimeBackendEvent>, e: &LocalAsrError) {
    let _ = event_tx.send(RealtimeBackendEvent::Error {
        code: e.code().to_string(),
        message: e.to_string(),
    });
}

fn relay_loop(
    mut session: Box<dyn StreamSession>,
    cmd_rx: Receiver<Command>,
    event_tx: Sender<RealtimeBackendEvent>,
) {
    let mut sentence_id: i64 = 0;
    let mut finishing = false;
    loop {
        // 先把积压的音频 / Finish 全部转给子进程。
        loop {
            match cmd_rx.try_recv() {
                Ok(Command::Audio(samples)) => session.send_audio(samples),
                Ok(Command::Finish) => {
                    session.finish();
                    finishing = true;
                }
                Err(TryRecvError::Empty) => break,
                // backend 被 drop（stt_cancel）且没走 finish：直接收工，session drop 发 Abort。
                Err(TryRecvError::Disconnected) if !finishing => return,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        let ev = match session.recv_timeout(POLL) {
            Ok(Event::Partial { text }) => RealtimeBackendEvent::Partial { sentence_id, text },
            Ok(Event::Final { text }) => {
                let ev = RealtimeBackendEvent::Final { sentence_id, text };
                sentence_id += 1;
                ev
            }
            Ok(Event::End) => {
                let _ = event_tx.send(RealtimeBackendEvent::EndOfStream);
                return;
            }
            // 加载事件由 host 自己消费，会话里不会出现；忽略以防万一。
            Ok(Event::Loaded { .. } | Event::LoadFailed { .. }) => continue,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                send_error(
                    &event_tx,
                    &LocalAsrError::EngineExited("host exited mid-session".into()),
                );
                return;
            }
        };
        if event_tx.send(ev).is_err() {
            return;
        }
    }
}

fn pcm16_le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

impl RealtimeAsrBackend for LocalRealtimeBackend {
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String> {
        let tx = self.cmd_tx.as_ref().ok_or("local asr session finished")?;
        tx.send(Command::Audio(pcm16_le_to_f32(&pcm16)))
            .map_err(|_| "local asr worker exited".to_string())
    }

    fn finish(&mut self) -> Result<(), String> {
        // Finish 之后不再收音频：take 掉 sender，worker 转发完 Finish 后等 End。
        let tx = self
            .cmd_tx
            .take()
            .ok_or("local asr session already finished")?;
        tx.send(Command::Finish)
            .map_err(|_| "local asr worker exited".to_string())
    }

    fn next_event_timeout(&mut self, dur: Duration) -> RealtimeBackendEvent {
        match self.event_rx.recv_timeout(dur) {
            Ok(ev) => ev,
            Err(RecvTimeoutError::Timeout) => RealtimeBackendEvent::Idle,
            Err(RecvTimeoutError::Disconnected) => {
                RealtimeBackendEvent::NetworkExit("local asr worker exited".into())
            }
        }
    }
}

impl Drop for LocalRealtimeBackend {
    fn drop(&mut self) {
        self.cmd_tx.take();
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假会话：每段音频回一个 Partial（累计采样数），finish 后回 Final + End。
    struct FakeSession {
        seen: usize,
        out: std::collections::VecDeque<Event>,
    }

    impl StreamSession for FakeSession {
        fn send_audio(&mut self, samples: Vec<f32>) {
            self.seen += samples.len();
            self.out.push_back(Event::Partial {
                text: self.seen.to_string(),
            });
        }
        fn finish(&mut self) {
            self.out.push_back(Event::Final {
                text: self.seen.to_string(),
            });
            self.out.push_back(Event::End);
        }
        fn recv_timeout(&mut self, d: Duration) -> Result<Event, RecvTimeoutError> {
            self.out.pop_front().ok_or_else(|| {
                std::thread::sleep(d);
                RecvTimeoutError::Timeout
            })
        }
    }

    fn fake_opener() -> SessionOpener {
        Box::new(|| {
            Ok(Box::new(FakeSession {
                seen: 0,
                out: Default::default(),
            }) as Box<dyn StreamSession>)
        })
    }

    fn collect_until_end(b: &mut LocalRealtimeBackend) -> Vec<RealtimeBackendEvent> {
        let mut events = Vec::new();
        for _ in 0..200 {
            let ev = b.next_event_timeout(Duration::from_millis(20));
            let end = matches!(
                ev,
                RealtimeBackendEvent::EndOfStream | RealtimeBackendEvent::NetworkExit(_)
            );
            if !matches!(ev, RealtimeBackendEvent::Idle) {
                events.push(ev);
            }
            if end {
                break;
            }
        }
        events
    }

    fn final_text(events: &[RealtimeBackendEvent]) -> Option<String> {
        events.iter().find_map(|e| match e {
            RealtimeBackendEvent::Final { text, .. } => Some(text.clone()),
            _ => None,
        })
    }

    // stt_finalize 依赖「Ready 先到、Final 全部先于 EndOfStream」这个顺序才能提前返回。
    #[test]
    fn emits_ready_then_final_before_end_of_stream() {
        let mut b = LocalRealtimeBackend::new(fake_opener()).unwrap();
        b.send_audio(vec![0u8; 320]).unwrap();
        b.finish().unwrap();
        let events = collect_until_end(&mut b);

        assert!(matches!(
            events.first(),
            Some(RealtimeBackendEvent::Ready { .. })
        ));
        assert!(matches!(
            events.last(),
            Some(RealtimeBackendEvent::EndOfStream)
        ));
        assert_eq!(final_text(&events).as_deref(), Some("160"));
    }

    // 加载期间送来的音频必须排队保留：冷启动 1.5s，丢了就是用户开头那句话没了。
    #[test]
    fn audio_sent_while_loading_is_kept() {
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let opener: SessionOpener = Box::new(move || {
            gate_rx.recv().unwrap();
            fake_opener()()
        });
        let mut b = LocalRealtimeBackend::new(opener).unwrap();
        b.send_audio(vec![0u8; 320]).unwrap();
        b.send_audio(vec![0u8; 320]).unwrap();
        b.finish().unwrap();
        gate_tx.send(()).unwrap();
        let events = collect_until_end(&mut b);
        assert_eq!(final_text(&events).as_deref(), Some("320"));
    }

    #[test]
    fn load_failure_surfaces_stable_error_code() {
        let opener: SessionOpener = Box::new(|| Err(LocalAsrError::Load("boom".into())));
        let mut b = LocalRealtimeBackend::new(opener).unwrap();
        let events = collect_until_end(&mut b);
        assert!(events.iter().any(|e| matches!(
            e,
            RealtimeBackendEvent::Error { code, .. } if code == "local_model_load_failed"
        )));
    }

    // 子进程中途崩溃：必须报错结束，不能让 stt_finalize 干等 30s。
    #[test]
    fn host_exit_mid_session_surfaces_error() {
        struct DeadSession;
        impl StreamSession for DeadSession {
            fn send_audio(&mut self, _: Vec<f32>) {}
            fn finish(&mut self) {}
            fn recv_timeout(&mut self, _: Duration) -> Result<Event, RecvTimeoutError> {
                Err(RecvTimeoutError::Disconnected)
            }
        }
        let opener: SessionOpener =
            Box::new(|| Ok(Box::new(DeadSession) as Box<dyn StreamSession>));
        let mut b = LocalRealtimeBackend::new(opener).unwrap();
        let events = collect_until_end(&mut b);
        assert!(events.iter().any(|e| matches!(
            e,
            RealtimeBackendEvent::Error { code, .. } if code == "local_engine_exited"
        )));
    }

    #[test]
    fn audio_after_finish_is_rejected() {
        let mut b = LocalRealtimeBackend::new(fake_opener()).unwrap();
        b.finish().unwrap();
        assert!(b.send_audio(vec![0u8; 4]).is_err());
    }

    #[test]
    fn pcm16_conversion_scales_to_unit_range() {
        let bytes = [0x00, 0x80, 0xff, 0x7f];
        let out = pcm16_le_to_f32(&bytes);
        assert_eq!(out[0], -1.0);
        assert!((out[1] - 0.99997).abs() < 1e-4);
    }
}
