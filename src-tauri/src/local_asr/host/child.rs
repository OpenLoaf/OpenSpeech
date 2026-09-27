// 推理子进程：`openspeech --local-asr-host` 启动后只跑这里，不初始化 Tauri / 窗口。
//
// 单线程顺序处理 stdin 帧：加载模型、开流、喂音频、冲刷尾句。解码远快于实时
// （1s 音频约 50ms），不需要额外线程；主进程侧有写线程兜着，stdin 管道满了
// 也不会卡住录音链路。stdin EOF（主进程退出 / 主动关闭）即退出，模型内存随进程
// 一起交还系统——这正是单独起进程的意义（进程内 drop 后 macOS malloc 不归还）。

use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use super::protocol::{self, Command, Event, LoadRequest};
use crate::local_asr::catalog;
use crate::local_asr::engine::{self, LocalAsrEngine, LocalAsrStream, StreamUpdate};
use crate::local_asr::error::LocalAsrError;

pub type EngineFactory<'a> =
    dyn Fn(&LoadRequest) -> Result<Arc<dyn LocalAsrEngine>, LocalAsrError> + 'a;

/// 子进程入口。返回值是进程退出码。
pub fn run() -> i32 {
    let factory = |req: &LoadRequest| {
        let spec = catalog::find(&req.model_id)
            .ok_or_else(|| LocalAsrError::UnknownModel(req.model_id.clone()))?;
        engine::load(spec, Path::new(&req.dir), req.threads)
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    match serve(&mut stdin.lock(), &mut stdout.lock(), &factory) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("local asr host: {e}");
            1
        }
    }
}

pub fn serve<R: Read, W: Write>(
    input: &mut R,
    out: &mut W,
    factory: &EngineFactory<'_>,
) -> io::Result<()> {
    let mut engine: Option<Arc<dyn LocalAsrEngine>> = None;
    let mut stream: Option<Box<dyn LocalAsrStream>> = None;
    let mut updates = Vec::new();

    while let Some(cmd) = protocol::read_command(input)? {
        match cmd {
            Command::Load(req) => {
                if engine
                    .as_ref()
                    .is_some_and(|e| e.model_id() == req.model_id)
                {
                    protocol::write_event(
                        out,
                        &Event::Loaded {
                            model_id: req.model_id,
                            ms: 0,
                        },
                    )?;
                    continue;
                }
                // 先放旧模型再加载新模型，避免两份权重同时驻留。
                stream = None;
                engine = None;
                let started = Instant::now();
                let ev = match factory(&req) {
                    Ok(e) => {
                        engine = Some(e);
                        Event::Loaded {
                            model_id: req.model_id,
                            ms: started.elapsed().as_millis() as u64,
                        }
                    }
                    Err(e) => Event::LoadFailed {
                        code: e.code().to_string(),
                        message: e.to_string(),
                    },
                };
                protocol::write_event(out, &ev)?;
            }
            Command::Start => match engine.clone() {
                Some(e) => stream = Some(e.open_stream()),
                None => {
                    protocol::write_event(
                        out,
                        &Event::LoadFailed {
                            code: LocalAsrError::Load(String::new()).code().to_string(),
                            message: "stream started before model loaded".into(),
                        },
                    )?;
                }
            },
            Command::Audio(samples) => {
                if let Some(s) = stream.as_mut() {
                    s.accept(&samples);
                    s.drain(&mut updates);
                    emit_updates(out, &mut updates)?;
                }
            }
            Command::Finish => {
                if let Some(mut s) = stream.take() {
                    s.finish();
                    s.drain(&mut updates);
                    emit_updates(out, &mut updates)?;
                }
                protocol::write_event(out, &Event::End)?;
            }
            Command::Abort => stream = None,
        }
    }
    Ok(())
}

fn emit_updates<W: Write>(out: &mut W, updates: &mut Vec<StreamUpdate>) -> io::Result<()> {
    for u in updates.drain(..) {
        let ev = match u {
            StreamUpdate::Partial(text) => Event::Partial { text },
            StreamUpdate::Final(text) => Event::Final { text },
        };
        protocol::write_event(out, &ev)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 假引擎：每次喂音频吐当前累计采样数的 Partial，finish 时吐 Final。
    pub struct FakeEngine(pub String);
    struct FakeStream {
        seen: usize,
        finished: bool,
    }

    impl LocalAsrEngine for FakeEngine {
        fn model_id(&self) -> &str {
            &self.0
        }
        fn open_stream(self: Arc<Self>) -> Box<dyn LocalAsrStream> {
            Box::new(FakeStream {
                seen: 0,
                finished: false,
            })
        }
    }

    impl LocalAsrStream for FakeStream {
        fn accept(&mut self, samples: &[f32]) {
            self.seen += samples.len();
        }
        fn finish(&mut self) {
            self.finished = true;
        }
        fn drain(&mut self, out: &mut Vec<StreamUpdate>) {
            let text = self.seen.to_string();
            out.push(if self.finished {
                StreamUpdate::Final(text)
            } else {
                StreamUpdate::Partial(text)
            });
        }
    }

    pub fn fake_factory(req: &LoadRequest) -> Result<Arc<dyn LocalAsrEngine>, LocalAsrError> {
        if req.model_id == "broken" {
            return Err(LocalAsrError::Load("boom".into()));
        }
        Ok(Arc::new(FakeEngine(req.model_id.clone())))
    }

    fn run_script(cmds: &[Command]) -> Vec<Event> {
        let mut input = Vec::new();
        for c in cmds {
            protocol::write_command(&mut input, c).unwrap();
        }
        let mut out = Vec::new();
        serve(&mut input.as_slice(), &mut out, &fake_factory).unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .filter_map(protocol::parse_event)
            .collect()
    }

    fn load(id: &str) -> Command {
        Command::Load(LoadRequest {
            model_id: id.into(),
            dir: "/nonexistent".into(),
            threads: 1,
        })
    }

    #[test]
    fn full_session_emits_partials_then_final_then_end() {
        let evs = run_script(&[
            load("m"),
            Command::Start,
            Command::Audio(vec![0.0; 160]),
            Command::Finish,
        ]);
        assert!(matches!(evs[0], Event::Loaded { .. }));
        assert_eq!(evs[1], Event::Partial { text: "160".into() });
        assert_eq!(evs[2], Event::Final { text: "160".into() });
        assert_eq!(evs[3], Event::End);
    }

    // 同一模型重复 Load 不能重新加载（冷加载 1.5s，每次按键都来一遍就白做了）。
    #[test]
    fn reloading_same_model_is_instant() {
        let evs = run_script(&[load("m"), load("m")]);
        assert_eq!(
            evs[1],
            Event::Loaded {
                model_id: "m".into(),
                ms: 0
            }
        );
    }

    #[test]
    fn load_failure_reports_stable_code() {
        let evs = run_script(&[load("broken")]);
        assert!(matches!(
            &evs[0],
            Event::LoadFailed { code, .. } if code == "local_model_load_failed"
        ));
    }

    // 取消后的流不能再吐字，也不能回 End（主进程那边会话已经没了）。
    #[test]
    fn aborted_stream_emits_nothing() {
        let evs = run_script(&[
            load("m"),
            Command::Start,
            Command::Abort,
            Command::Audio(vec![0.0; 160]),
        ]);
        assert_eq!(evs.len(), 1);
    }
}
