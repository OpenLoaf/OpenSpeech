// 本地推理子进程的主进程侧：按需拉起、闲置退出、一次一路识别流。
//
// 为什么要单独起进程（实测 X-ASR，macOS）：进程内 drop 模型后，onnxruntime 释放的
// 内存留在 malloc 池里不还系统，反复加载卸载后稳定占 200~290MB，「闲置卸载」省不下
// 什么；子进程退出则全额归还。顺带隔离了 onnxruntime 的崩溃，不会带走主程序。
//
// 生命周期：
//   第一次按键（或设置页点「使用」预热）→ spawn 子进程 + Load（冷加载约 1.5s，
//   期间推 engine 状态 loading，悬浮条显示「本地模型启动中」）→ 会话复用常驻子进程 →
//   闲置 IDLE_EXIT 无会话 → kill，内存归零。主进程退出时子进程 stdin EOF 自行退出。
//
// 线程：每个子进程配 writer（命令队列 → stdin，队列无界，加载期间积压的音频不会
// 反压到录音链路）、reader（stdout JSON 事件）、stderr（转日志）三条线程；全局一条
// reaper 线程做闲置回收。

pub mod child;
pub mod protocol;

use std::io::{BufRead, BufReader, BufWriter};
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};

use super::catalog;
use super::engine;
use super::error::LocalAsrError;
use super::install;
use protocol::{Command, Event, LoadRequest};

/// 子进程命令行开关：main.rs 见到它就走 child::run，不启动 Tauri。
pub const HOST_ARG: &str = "--local-asr-host";

/// 闲置多久无会话就退出子进程。连续听写期间一直复用，只有长时间不用才归还内存。
const IDLE_EXIT: Duration = Duration::from_secs(5 * 60);
const REAP_INTERVAL: Duration = Duration::from_secs(30);
/// 冷加载实测 1.5s；给慢盘 / 低端机留足余量。
const LOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// 推给前端的引擎状态：loading / ready / failed / stopped。
pub type StateEmitter = Arc<dyn Fn(&str, &'static str, Option<String>) + Send + Sync>;

#[derive(Debug, Clone)]
enum LoadState {
    Loading,
    Loaded,
    Failed(LocalAsrError),
    Exited,
}

struct Shared {
    model_id: String,
    state: Mutex<LoadState>,
    changed: Condvar,
    /// 当前会话的事件出口；reader 线程把识别事件投到这里。None = 无会话，事件丢弃。
    sink: Mutex<Option<Sender<Event>>>,
}

impl Shared {
    fn set_state(&self, s: LoadState) {
        if let Ok(mut g) = self.state.lock() {
            *g = s;
        }
        self.changed.notify_all();
    }

    fn state(&self) -> LoadState {
        self.state
            .lock()
            .map(|g| g.clone())
            .unwrap_or(LoadState::Exited)
    }
}

struct Host {
    child: Child,
    cmd_tx: Sender<Command>,
    shared: Arc<Shared>,
    last_used: Instant,
    emit: StateEmitter,
}

impl Host {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
            && !matches!(
                self.shared.state(),
                LoadState::Exited | LoadState::Failed(_)
            )
    }

    fn kill(mut self, reason: &str) {
        log::info!(
            "[local_asr] host exit model={} reason={reason}",
            self.shared.model_id
        );
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.shared.set_state(LoadState::Exited);
        (self.emit)(&self.shared.model_id, "stopped", None);
    }
}

fn host_slot() -> &'static Mutex<Option<Host>> {
    static H: Mutex<Option<Host>> = Mutex::new(None);
    &H
}

/// 同一时刻只允许一路识别流（实时听写与历史重试互斥，后到者排队）。
/// 用 bool + Condvar 而不是持有 MutexGuard：会话要能跨线程移动（MutexGuard 不是 Send）。
struct SessionGate {
    busy: Mutex<bool>,
    freed: Condvar,
}

impl SessionGate {
    fn acquire(&self) -> Result<(), LocalAsrError> {
        let mut busy = self
            .busy
            .lock()
            .map_err(|e| LocalAsrError::Load(e.to_string()))?;
        while *busy {
            busy = self
                .freed
                .wait(busy)
                .map_err(|e| LocalAsrError::Load(e.to_string()))?;
        }
        *busy = true;
        Ok(())
    }

    fn release(&self) {
        if let Ok(mut busy) = self.busy.lock() {
            *busy = false;
        }
        self.freed.notify_one();
    }

    fn is_busy(&self) -> bool {
        self.busy.lock().map(|b| *b).unwrap_or(true)
    }
}

fn session_gate() -> &'static SessionGate {
    static G: SessionGate = SessionGate {
        busy: Mutex::new(false),
        freed: Condvar::new(),
    };
    &G
}

fn emitter_for<R: Runtime>(app: &AppHandle<R>) -> StateEmitter {
    let app = app.clone();
    Arc::new(move |model_id, state, error| {
        super::emit_engine_state(&app, model_id, state, error);
    })
}

fn spawn_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("openspeech-local-asr-reaper".into())
            .spawn(|| {
                loop {
                    std::thread::sleep(REAP_INTERVAL);
                    let Ok(mut slot) = host_slot().lock() else {
                        continue;
                    };
                    let idle = slot
                        .as_ref()
                        .is_some_and(|h| h.last_used.elapsed() >= IDLE_EXIT);
                    // 会话进行中不回收。
                    if idle
                        && !session_gate().is_busy()
                        && let Some(h) = slot.take()
                    {
                        h.kill("idle");
                    }
                }
            });
    });
}

fn spawn_host(
    model_id: &str,
    dir: &std::path::Path,
    emit: StateEmitter,
) -> Result<Host, LocalAsrError> {
    let exe =
        std::env::current_exe().map_err(|e| LocalAsrError::Load(format!("current_exe: {e}")))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(HOST_ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| LocalAsrError::Load(format!("spawn host: {e}")))?;
    log::info!(
        "[local_asr] host spawned pid={} model={model_id}",
        child.id()
    );

    let shared = Arc::new(Shared {
        model_id: model_id.to_string(),
        state: Mutex::new(LoadState::Loading),
        changed: Condvar::new(),
        sink: Mutex::new(None),
    });

    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();

    let spawn = |name: &str, f: Box<dyn FnOnce() + Send>| {
        std::thread::Builder::new()
            .name(name.into())
            .spawn(f)
            .map(|_| ())
            .map_err(|e| LocalAsrError::Load(format!("spawn {name}: {e}")))
    };

    spawn(
        "openspeech-local-asr-writer",
        Box::new(move || {
            let mut w = BufWriter::new(stdin);
            while let Ok(c) = cmd_rx.recv() {
                if protocol::write_command(&mut w, &c).is_err() {
                    break;
                }
            }
        }),
    )?;

    let reader_shared = shared.clone();
    let reader_emit = emit.clone();
    spawn(
        "openspeech-local-asr-reader",
        Box::new(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Some(ev) = protocol::parse_event(&line) else {
                    log::warn!("[local_asr] host sent unparsable line: {line}");
                    continue;
                };
                match ev {
                    Event::Loaded { model_id, ms } => {
                        if ms > 0 {
                            log::info!("[local_asr] model loaded in host model={model_id} ms={ms}");
                        }
                        reader_shared.set_state(LoadState::Loaded);
                        reader_emit(&model_id, "ready", None);
                    }
                    Event::LoadFailed { code, message } => {
                        log::warn!("[local_asr] host load failed code={code}: {message}");
                        let err = LocalAsrError::Load(message);
                        reader_emit(&reader_shared.model_id, "failed", Some(code));
                        reader_shared.set_state(LoadState::Failed(err));
                    }
                    stream_ev => {
                        if let Ok(g) = reader_shared.sink.lock()
                            && let Some(tx) = g.as_ref()
                        {
                            let _ = tx.send(stream_ev);
                        }
                    }
                }
            }
            // stdout 关闭 = 子进程已退出（被回收 / 崩溃）。清掉 sink 让在途会话立刻感知。
            if let Ok(mut g) = reader_shared.sink.lock() {
                g.take();
            }
            reader_shared.set_state(LoadState::Exited);
        }),
    )?;

    spawn(
        "openspeech-local-asr-stderr",
        Box::new(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[local_asr:host] {line}");
            }
        }),
    )?;

    emit(model_id, "loading", None);
    let _ = cmd_tx.send(Command::Load(LoadRequest {
        model_id: model_id.to_string(),
        dir: dir.to_string_lossy().into_owned(),
        threads: engine::inference_threads(),
    }));

    Ok(Host {
        child,
        cmd_tx,
        shared,
        last_used: Instant::now(),
        emit,
    })
}

/// 确保有一个加载着 model_id 的子进程（没有就拉起），返回它的共享状态与命令通道。
/// 不等加载完成。
fn ensure<R: Runtime>(
    app: &AppHandle<R>,
    model_id: &str,
) -> Result<(Arc<Shared>, Sender<Command>), LocalAsrError> {
    let spec =
        catalog::find(model_id).ok_or_else(|| LocalAsrError::UnknownModel(model_id.to_string()))?;
    let dir = install::model_dir(app, spec)?;
    if !install::is_installed_at(&dir, spec) {
        return Err(LocalAsrError::NotInstalled(model_id.to_string()));
    }

    let mut slot = host_slot()
        .lock()
        .map_err(|e| LocalAsrError::Load(e.to_string()))?;
    if let Some(h) = slot.as_mut()
        && h.shared.model_id == model_id
        && h.alive()
    {
        h.last_used = Instant::now();
        return Ok((h.shared.clone(), h.cmd_tx.clone()));
    }
    // 换模型 / 子进程已死：整个进程换掉，不在同一进程里切模型（切过的进程同样留残余内存）。
    if let Some(old) = slot.take() {
        old.kill("replaced");
    }
    spawn_reaper();
    let host = spawn_host(model_id, &dir, emitter_for(app))?;
    let out = (host.shared.clone(), host.cmd_tx.clone());
    *slot = Some(host);
    Ok(out)
}

fn wait_loaded(shared: &Shared) -> Result<(), LocalAsrError> {
    let deadline = Instant::now() + LOAD_TIMEOUT;
    let mut g = shared
        .state
        .lock()
        .map_err(|e| LocalAsrError::Load(e.to_string()))?;
    loop {
        match &*g {
            LoadState::Loaded => return Ok(()),
            LoadState::Failed(e) => return Err(e.clone()),
            LoadState::Exited => return Err(LocalAsrError::EngineExited("during load".into())),
            LoadState::Loading => {}
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(LocalAsrError::Load("load timed out".into()));
        }
        g = shared
            .changed
            .wait_timeout(g, left)
            .map_err(|e| LocalAsrError::Load(e.to_string()))?
            .0;
    }
}

/// 预热：拉起子进程并加载，不开流。设置页点「使用」时调，让第一次按键不用等。
pub fn preload<R: Runtime>(app: &AppHandle<R>, model_id: &str) -> Result<(), LocalAsrError> {
    let (shared, _) = ensure(app, model_id)?;
    // 已加载时 ensure 不会推状态，这里补一个 ready 让设置页刷新。
    if matches!(shared.state(), LoadState::Loaded) {
        super::emit_engine_state(app, model_id, "ready", None);
    }
    wait_loaded(&shared)
}

/// 立即结束子进程（切走本地通道 / 删除模型）。
pub fn shutdown(reason: &str) {
    let host = host_slot().lock().ok().and_then(|mut g| g.take());
    if let Some(h) = host {
        h.kill(reason);
    }
}

pub fn loaded_model_id() -> Option<String> {
    let mut slot = host_slot().lock().ok()?;
    let h = slot.as_mut()?;
    (h.alive() && matches!(h.shared.state(), LoadState::Loaded)).then(|| h.shared.model_id.clone())
}

/// 一路识别流。持有期间独占子进程；drop 时未结束的流发 Abort。
pub struct HostSession {
    cmd_tx: Sender<Command>,
    events: Receiver<Event>,
    shared: Arc<Shared>,
    ended: bool,
}

/// 抽象出来给 asr/backends/local.rs 用，测试里可以换成假会话。
pub trait StreamSession: Send {
    fn send_audio(&mut self, samples: Vec<f32>);
    fn finish(&mut self);
    /// Disconnected = 子进程已退出。
    fn recv_timeout(&mut self, d: Duration) -> Result<Event, RecvTimeoutError>;
}

impl HostSession {
    /// 阻塞直到模型可用（冷启动约 1.5s）并开好流。调用方须在后台线程。
    pub fn open<R: Runtime>(app: &AppHandle<R>, model_id: &str) -> Result<Self, LocalAsrError> {
        session_gate().acquire()?;
        let opened = Self::open_inner(app, model_id);
        if opened.is_err() {
            session_gate().release();
        }
        opened
    }

    fn open_inner<R: Runtime>(app: &AppHandle<R>, model_id: &str) -> Result<Self, LocalAsrError> {
        let (shared, cmd_tx) = ensure(app, model_id)?;
        wait_loaded(&shared)?;
        let (tx, rx) = mpsc::channel();
        if let Ok(mut g) = shared.sink.lock() {
            *g = Some(tx);
        }
        cmd_tx
            .send(Command::Start)
            .map_err(|_| LocalAsrError::EngineExited("start".into()))?;
        Ok(Self {
            cmd_tx,
            events: rx,
            shared,
            ended: false,
        })
    }
}

impl StreamSession for HostSession {
    fn send_audio(&mut self, samples: Vec<f32>) {
        let _ = self.cmd_tx.send(Command::Audio(samples));
    }

    fn finish(&mut self) {
        let _ = self.cmd_tx.send(Command::Finish);
    }

    fn recv_timeout(&mut self, d: Duration) -> Result<Event, RecvTimeoutError> {
        let ev = self.events.recv_timeout(d)?;
        if matches!(ev, Event::End) {
            self.ended = true;
        }
        Ok(ev)
    }
}

impl Drop for HostSession {
    fn drop(&mut self) {
        if !self.ended {
            let _ = self.cmd_tx.send(Command::Abort);
        }
        if let Ok(mut g) = self.shared.sink.lock() {
            g.take();
        }
        // 闲置计时从会话结束算起。
        if let Ok(mut slot) = host_slot().lock()
            && let Some(h) = slot.as_mut()
            && Arc::ptr_eq(&h.shared, &self.shared)
        {
            h.last_used = Instant::now();
        }
        session_gate().release();
    }
}
