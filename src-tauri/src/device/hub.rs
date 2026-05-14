// DeviceHub：进程级单例，持有 registry + 在线连接表 + WS listener 任务句柄。
// P0 仅明文 ws；mDNS 用 mdns-sd 发布。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tauri::async_runtime::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request as HandshakeRequest, Response as HandshakeResponse,
};
use tokio_tungstenite::tungstenite::http::{Response as HttpResponse, StatusCode};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
use tokio_tungstenite::tungstenite::Message;
use futures_util::{SinkExt, StreamExt};

use super::event::{DeviceEvent, TextResultInfo};
use super::protocol::{
    self, DeviceId, PROTOCOL_VERSION_MAJOR, http_headers,
};
use super::registry::{DeviceRecord, DeviceRegistry, PersistentRegistry};

// 协议固定端口：BLE_PROVISIONING_PROTOCOL.md 第 5.3 节点名 server_port 固定建议 17878。
// 配网时桌面端把这个端口写进 provision payload；设备拿到后 ws://device_ip:17878 连回桌面。
const DEFAULT_PORT: u16 = 17878;
const WS_PATH: &str = "/openspeech-mic";
const MDNS_SERVICE_TYPE: &str = "_openspeech-mic._tcp.local.";
const PING_INTERVAL_SECS: u64 = 10;
const STALE_TIMEOUT_SECS: u64 = 30;
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// 通用事件名常量；契约要求 `openspeech://device-*` 前缀。
pub const EVT_SERVER_STATUS: &str = "openspeech://device-server-status";
pub const EVT_CONNECTED: &str = "openspeech://device-connected";
pub const EVT_DISCONNECTED: &str = "openspeech://device-disconnected";
pub const EVT_DEVICE_EVENT: &str = "openspeech://device-event";
pub const EVT_DEVICE_ERROR: &str = "openspeech://device-error";
pub const EVT_AUDIO_CHUNK_META: &str = "openspeech://device-audio-chunk-meta";
pub const EVT_LIST_CHANGED: &str = "openspeech://device-list-changed";

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub mdns_instance: String,
    pub cert_sha256: Option<String>,
    pub connected_count: usize,
    pub started_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceRecordView {
    pub device_id: String,
    pub label: String,
    pub bound_user_id: String,
    pub token_seq: u32,
    pub last_protocol_version: String,
    pub last_firmware_semver: String,
    pub first_paired_at_ms: u64,
    pub last_seen_at_ms: u64,
    pub peer_cert_sha256: Option<String>,
    pub online: bool,
    pub channel: Option<String>,
    pub rssi_dbm: Option<i8>,
    pub rtt_ms: Option<u16>,
    pub battery_pct: Option<u8>,
    pub battery_tier: Option<String>,
    pub last_text_result: Option<String>,
    pub last_text_result_at_ms: Option<u64>,
    /// 多设备单激活：当前是否是被路由的"主"设备
    pub is_active: bool,
}

// 单个在线连接对外暴露的能力：发 JSON、主动断开。真正的 ws sink 用 mpsc 解耦。
struct ConnectionHandle {
    device_id: DeviceId,
    peer_addr: SocketAddr,
    outbound: UnboundedSender<Message>,
    last_seen_at_ms: u64,
    last_text_result: Option<String>,
    last_text_result_at_ms: Option<u64>,
}

pub struct DeviceHub {
    app: AppHandle,
    registry: Arc<PersistentRegistry>,
    connections: Mutex<HashMap<DeviceId, ConnectionHandle>>,
    started_at_ms: Mutex<Option<u64>>,
    listener_task: Mutex<Option<JoinHandle<()>>>,
    mdns_daemon: Mutex<Option<mdns_sd::ServiceDaemon>>,
    mdns_instance: Mutex<String>,
    port: Mutex<u16>,
    running: AtomicBool,
}

impl DeviceHub {
    pub fn new(app: AppHandle) -> Self {
        // app_data_dir 在 setup 阶段一定可用；拿不到则回退到当前目录（dev / 沙盒异常时不致命）
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let registry_path = data_dir.join("devices.json");
        log::info!("[device] registry path = {}", registry_path.display());
        Self {
            app,
            registry: Arc::new(PersistentRegistry::open(registry_path)),
            connections: Mutex::new(HashMap::new()),
            started_at_ms: Mutex::new(None),
            listener_task: Mutex::new(None),
            mdns_daemon: Mutex::new(None),
            mdns_instance: Mutex::new(String::new()),
            port: Mutex::new(DEFAULT_PORT),
            running: AtomicBool::new(false),
        }
    }

    pub async fn start(self: &Arc<Self>) -> anyhow::Result<()> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(()); // 已运行直接幂等
        }
        let port = *self.port.lock().await;
        let bind = format!("0.0.0.0:{port}");
        let listener = TcpListener::bind(&bind).await?;
        log::info!("[device] WS listener bound on {bind}");

        let hub = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        let hub2 = hub.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = hub2.handle_incoming(stream, addr).await {
                                log::warn!("[device] connection from {addr} ended: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        log::warn!("[device] accept error: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            }
        });

        *self.listener_task.lock().await = Some(handle);
        *self.started_at_ms.lock().await = Some(now_ms());

        // mDNS：注册失败不致命，记 warn 即可
        match register_mdns(port).await {
            Ok((daemon, instance)) => {
                *self.mdns_daemon.lock().await = Some(daemon);
                *self.mdns_instance.lock().await = instance;
            }
            Err(e) => log::warn!("[device] mDNS register failed: {e}"),
        }

        self.emit_server_status().await;
        Ok(())
    }

    pub async fn stop(self: &Arc<Self>) -> anyhow::Result<()> {
        if !self.running.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(h) = self.listener_task.lock().await.take() {
            h.abort();
        }
        if let Some(d) = self.mdns_daemon.lock().await.take() {
            let _ = d.shutdown();
        }
        // 主动关闭所有在线连接
        let mut conns = self.connections.lock().await;
        for (_, ch) in conns.drain() {
            let _ = ch.outbound.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "server stop".into(),
            })));
        }
        *self.started_at_ms.lock().await = None;
        self.emit_server_status().await;
        Ok(())
    }

    pub async fn status(&self) -> ServerStatus {
        let port = *self.port.lock().await;
        let instance = self.mdns_instance.lock().await.clone();
        let started = *self.started_at_ms.lock().await;
        let count = self.connections.lock().await.len();
        ServerStatus {
            running: self.running.load(Ordering::SeqCst),
            host: local_lan_ip().unwrap_or_else(|| "127.0.0.1".into()),
            port,
            mdns_instance: instance,
            cert_sha256: None, // P0 明文 ws
            connected_count: count,
            started_at_ms: started,
        }
    }

    pub fn registry(&self) -> Arc<PersistentRegistry> {
        self.registry.clone()
    }

    /// 多设备单激活：把指定 device_id 设为唯一 active；不存在则返回 Err。
    pub async fn set_active(self: &Arc<Self>, device_id: &str) -> Result<(), String> {
        if !self.registry.set_active(device_id) {
            return Err("device not found".into());
        }
        self.emit_list_changed().await;
        Ok(())
    }

    pub async fn list_devices(&self) -> Vec<DeviceRecordView> {
        let conns = self.connections.lock().await;
        let online: std::collections::HashSet<DeviceId> = conns.keys().cloned().collect();
        let extra: HashMap<DeviceId, (Option<String>, Option<u64>)> = conns
            .iter()
            .map(|(k, v)| (k.clone(), (v.last_text_result.clone(), v.last_text_result_at_ms)))
            .collect();
        drop(conns);

        self.registry
            .list()
            .into_iter()
            .map(|r| {
                let is_online = online.contains(&r.device_id);
                let (last_text, last_text_at) = extra.get(&r.device_id).cloned().unwrap_or((None, None));
                DeviceRecordView {
                    device_id: r.device_id,
                    label: r.label,
                    bound_user_id: r.bound_user_id,
                    token_seq: r.token_seq,
                    last_protocol_version: r.last_protocol_version,
                    last_firmware_semver: r.last_firmware_semver,
                    first_paired_at_ms: r.first_paired_at_ms,
                    last_seen_at_ms: r.last_seen_at_ms,
                    peer_cert_sha256: r.peer_cert_sha256,
                    online: is_online,
                    channel: if is_online { Some("wifi".into()) } else { None },
                    rssi_dbm: None,
                    rtt_ms: None,
                    battery_pct: None,
                    battery_tier: None,
                    last_text_result: last_text,
                    last_text_result_at_ms: last_text_at,
                    is_active: r.is_active,
                }
            })
            .collect()
    }

    pub async fn get_device(&self, device_id: &str) -> Option<DeviceRecordView> {
        self.list_devices().await.into_iter().find(|d| d.device_id == device_id)
    }

    pub async fn remove_device(self: &Arc<Self>, device_id: &str) {
        // 先尝试断连，再从 registry 移除
        if let Some(ch) = self.connections.lock().await.remove(device_id) {
            let _ = ch.outbound.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "unbound".into(),
            })));
        }
        // 删除前先看是不是当前 active；是的话稍后要 promote 另一台
        let was_active = self
            .registry
            .get(device_id)
            .map(|r| r.is_active)
            .unwrap_or(false);
        self.registry.remove(device_id);

        if was_active {
            // 选最近活跃的剩余 record 接班；都没有就没人 active
            if let Some(next) = self
                .registry
                .list()
                .into_iter()
                .max_by_key(|r| r.last_seen_at_ms)
            {
                let _ = self.registry.set_active(&next.device_id);
            }
        }
        self.emit_list_changed().await;
    }

    pub async fn clear_all(self: &Arc<Self>) {
        let mut conns = self.connections.lock().await;
        for (_, ch) in conns.drain() {
            let _ = ch.outbound.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "clear_all".into(),
            })));
        }
        drop(conns);
        for r in self.registry.list() {
            self.registry.remove(&r.device_id);
        }
        self.emit_list_changed().await;
    }

    pub async fn rename(&self, device_id: &str, label: &str) -> Result<(), String> {
        let mut rec = self
            .registry
            .get(device_id)
            .ok_or_else(|| "device not found".to_string())?;
        rec.label = label.to_string();
        self.registry.upsert(rec);
        let _ = self.app.emit(EVT_LIST_CHANGED, serde_json::json!({ "count": self.registry.list().len() }));
        Ok(())
    }

    // 手动下发 text_result；P0 不接 STT，纯用户触发。
    pub async fn send_text(
        &self,
        device_id: &str,
        text: &str,
        target_app: Option<&str>,
    ) -> Result<(), String> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let envelope = serde_json::json!({
            "msg_id": uuid::Uuid::new_v4().to_string(),
            "ts_ms": now_ms(),
            "t": "text_result",
            "session_id": session_id,
            "text": text,
            "delivery_mode": "injected",
            "target_app": target_app.unwrap_or(""),
            "language_detected": "",
        });
        let mut conns = self.connections.lock().await;
        let ch = conns.get_mut(device_id).ok_or_else(|| "device not online".to_string())?;
        ch.last_text_result = Some(text.to_string());
        ch.last_text_result_at_ms = Some(now_ms());
        ch.outbound
            .send(Message::Text(envelope.to_string()))
            .map_err(|e| format!("send failed: {e}"))
    }

    // P0 stub：每秒推 OtaProgress 10/20/.../100，结束发 OtaResult。
    pub async fn push_ota_stub(
        self: &Arc<Self>,
        device_id: String,
        target_version: String,
    ) -> Result<String, String> {
        let offer_id = uuid::Uuid::new_v4().to_string();
        let hub = self.clone();
        let did = device_id.clone();
        tauri::async_runtime::spawn(async move {
            for pct in (10..=100).step_by(10) {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                hub.emit_device_event(DeviceEvent::OtaProgress {
                    device_id: did.clone(),
                    percent: pct as u8,
                    estimated_remaining_ms: ((100 - pct) as u32) * 1000,
                })
                .await;
            }
            hub.emit_device_event(DeviceEvent::OtaResult {
                device_id: did.clone(),
                outcome: super::protocol::OtaOutcome::Ok,
                err_if_any: None,
            })
            .await;
        });
        log::info!("[device] ota stub start offer={offer_id} target={target_version}");
        Ok(offer_id)
    }


    // ============================================================================
    // 内部：连接生命周期
    // ============================================================================

    async fn handle_incoming(
        self: Arc<Self>,
        stream: TcpStream,
        peer_addr: SocketAddr,
    ) -> anyhow::Result<()> {
        let mut hdr_device_id: Option<String> = None;
        let mut hdr_protocol: Option<String> = None;
        let mut hdr_firmware: Option<String> = None;
        let mut hdr_path_ok = false;

        let callback = |req: &HandshakeRequest,
                        resp: HandshakeResponse|
         -> Result<HandshakeResponse, ErrorResponse> {
            hdr_path_ok = req.uri().path() == WS_PATH;
            for (name, value) in req.headers() {
                let lname = name.as_str().to_ascii_lowercase();
                let v = value.to_str().unwrap_or("").to_string();
                if lname.eq_ignore_ascii_case(&http_headers::DEVICE_ID.to_ascii_lowercase()) {
                    hdr_device_id = Some(v);
                } else if lname.eq_ignore_ascii_case(&http_headers::PROTOCOL.to_ascii_lowercase()) {
                    hdr_protocol = Some(v);
                } else if lname.eq_ignore_ascii_case(&http_headers::FIRMWARE.to_ascii_lowercase()) {
                    hdr_firmware = Some(v);
                }
            }
            // 升级头/路径不齐：拒绝
            if !hdr_path_ok || hdr_device_id.is_none() || hdr_protocol.is_none() {
                let body = HttpResponse::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Some("missing headers".to_string()))
                    .unwrap();
                return Err(body);
            }
            // major 协议号不匹配：直接拒
            if let Some(pv) = hdr_protocol.as_ref() {
                let major = pv.split('.').next().and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
                if major != PROTOCOL_VERSION_MAJOR {
                    let body = HttpResponse::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Some("protocol_major_mismatch".to_string()))
                        .unwrap();
                    return Err(body);
                }
            }
            Ok(resp)
        };

        let ws = accept_hdr_async(stream, callback).await?;
        let device_id = hdr_device_id.unwrap_or_default();
        let protocol_version = hdr_protocol.unwrap_or_default();
        let firmware = hdr_firmware.unwrap_or_default();
        log::info!(
            "[device] handshake ok device_id={device_id} proto={protocol_version} peer={peer_addr}"
        );
        self.run_session(ws, device_id, protocol_version, firmware, peer_addr).await
    }

    async fn run_session(
        self: Arc<Self>,
        ws: WebSocketStream<TcpStream>,
        device_id: DeviceId,
        protocol_version: String,
        firmware: String,
        peer_addr: SocketAddr,
    ) -> anyhow::Result<()> {
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = unbounded_channel::<Message>();

        // 注册连接 + upsert registry
        {
            let now = now_ms();
            let existing = self.registry.get(&device_id);
            // 首台设备自动激活：当前 registry 无 active 时，这次握手的设备就成为 active
            let auto_active = existing
                .as_ref()
                .map(|r| r.is_active)
                .unwrap_or_else(|| self.registry.active_id().is_none());
            let rec = DeviceRecord {
                device_id: device_id.clone(),
                label: existing
                    .as_ref()
                    .map(|r| r.label.clone())
                    .unwrap_or_else(|| short_label(&device_id)),
                bound_user_id: existing.as_ref().map(|r| r.bound_user_id.clone()).unwrap_or_default(),
                token_seq: existing.as_ref().map(|r| r.token_seq).unwrap_or(0),
                last_protocol_version: protocol_version.clone(),
                last_firmware_semver: firmware.clone(),
                first_paired_at_ms: existing.as_ref().map(|r| r.first_paired_at_ms).unwrap_or(now),
                last_seen_at_ms: now,
                peer_cert_sha256: None,
                is_active: auto_active,
            };
            self.registry.upsert(rec);
            self.connections.lock().await.insert(
                device_id.clone(),
                ConnectionHandle {
                    device_id: device_id.clone(),
                    peer_addr,
                    outbound: tx.clone(),
                    last_seen_at_ms: now,
                    last_text_result: None,
                    last_text_result_at_ms: None,
                },
            );
        }
        self.emit_list_changed().await;

        // writer task：把 mpsc 的 Message 写到 ws sink
        let writer = tauri::async_runtime::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Err(e) = sink.send(msg).await {
                    log::debug!("[device] sink write end: {e}");
                    break;
                }
            }
        });

        // ping ticker：周期发 ping
        let ping_tx = tx.clone();
        let did_for_ping = device_id.clone();
        let ping_task = tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(PING_INTERVAL_SECS));
            tick.tick().await; // 跳过 immediate tick
            loop {
                tick.tick().await;
                let env = serde_json::json!({
                    "msg_id": uuid::Uuid::new_v4().to_string(),
                    "ts_ms": now_ms(),
                    "t": "ping",
                    "nonce": uuid::Uuid::new_v4().simple().to_string(),
                });
                if ping_tx.send(Message::Text(env.to_string())).is_err() {
                    log::debug!("[device] ping task exit (channel closed) device={did_for_ping}");
                    break;
                }
            }
        });

        // 当前 session 的 audio 写文件句柄
        let mut audio_file: Option<(String, File)> = None;
        let mut close_reason = "peer_close".to_string();

        // 读循环：附带 stale watchdog
        loop {
            let recv = tokio::time::timeout(
                std::time::Duration::from_secs(STALE_TIMEOUT_SECS),
                stream.next(),
            )
            .await;
            match recv {
                Err(_) => {
                    close_reason = "heartbeat_timeout".into();
                    break;
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => {
                    log::debug!("[device] ws read err: {e}");
                    break;
                }
                Ok(Some(Ok(msg))) => {
                    match msg {
                        Message::Text(txt) => {
                            self.touch_last_seen(&device_id).await;
                            self.dispatch_text(&device_id, &txt, &tx, &mut audio_file).await;
                        }
                        Message::Binary(_) => {
                            // P0 不接收纯二进制 frame；audio_chunk 用 JSON + base64 走 Text
                        }
                        Message::Ping(p) => {
                            let _ = tx.send(Message::Pong(p));
                        }
                        Message::Pong(_) => {
                            self.touch_last_seen(&device_id).await;
                        }
                        Message::Close(_) => break,
                        Message::Frame(_) => {}
                    }
                }
            }
        }

        // 清理
        ping_task.abort();
        // tx drop 后 writer 自然退出
        drop(tx);
        let _ = writer.await;

        if let Some((_sid, mut f)) = audio_file.take() {
            let _ = f.flush().await;
        }
        self.connections.lock().await.remove(&device_id);

        let _ = self.app.emit(
            EVT_DISCONNECTED,
            serde_json::json!({
                "device_id": device_id,
                "channel": "wifi",
                "reason": close_reason,
            }),
        );
        self.emit_list_changed().await;
        self.emit_server_status().await;
        Ok(())
    }

    // 入站文本分发：先解 envelope header，按 t 走不同分支。
    async fn dispatch_text(
        self: &Arc<Self>,
        device_id: &str,
        raw: &str,
        out: &UnboundedSender<Message>,
        audio_file: &mut Option<(String, File)>,
    ) {
        let v: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[device] bad json from {device_id}: {e}");
                return;
            }
        };
        let kind = v.get("t").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            "hello" => {
                let token_seq = v.get("token_seq").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let ack = serde_json::json!({
                    "msg_id": uuid::Uuid::new_v4().to_string(),
                    "ts_ms": now_ms(),
                    "t": "hello_ack",
                    "app_version": APP_VERSION,
                    "server_protocol": protocol::PROTOCOL_VERSION,
                    "server_time_ms": now_ms(),
                    "token_seq": token_seq,
                    "min_supported_firmware": "0.1.0",
                });
                let _ = out.send(Message::Text(ack.to_string()));
                let firmware = v
                    .get("firmware_semver")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let protocol_version = v
                    .get("protocol_version")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let peer_addr = self
                    .connections
                    .lock()
                    .await
                    .get(device_id)
                    .map(|c| c.peer_addr.to_string())
                    .unwrap_or_default();
                let _ = self.app.emit(
                    EVT_CONNECTED,
                    serde_json::json!({
                        "device_id": device_id,
                        "channel": "wifi",
                        "peer_addr": peer_addr,
                        "protocol_version": protocol_version,
                        "firmware": firmware,
                    }),
                );
                self.emit_server_status().await;
            }
            "ping" => {
                let nonce = v.get("nonce").and_then(|x| x.as_str()).unwrap_or("");
                let ts_ms = v.get("ts_ms").and_then(|x| x.as_u64()).unwrap_or(now_ms());
                let pong = serde_json::json!({
                    "msg_id": uuid::Uuid::new_v4().to_string(),
                    "ts_ms": now_ms(),
                    "t": "pong",
                    "echo_ts_ms": ts_ms,
                    "echo_nonce": nonce,
                });
                let _ = out.send(Message::Text(pong.to_string()));
            }
            "pong" => {
                // 仅 touch last_seen，已在 caller 完成
            }
            "audio_chunk_meta" => {
                let session_id = v.get("session_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let seq = v.get("seq").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let data_b64 = v.get("data").and_then(|x| x.as_str()).unwrap_or("");
                let bytes = match base64_decode(data_b64) {
                    Ok(b) => b,
                    Err(_) => Vec::new(),
                };
                let nbytes = bytes.len();

                // 写盘：按 session_id 单文件追加
                if let Some(dir) = audio_dir(&self.app, device_id) {
                    let _ = tokio::fs::create_dir_all(&dir).await;
                    let need_new = audio_file
                        .as_ref()
                        .map(|(sid, _)| sid != &session_id)
                        .unwrap_or(true);
                    if need_new {
                        let path = dir.join(format!("{session_id}.pcm"));
                        match OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                            .await
                        {
                            Ok(f) => *audio_file = Some((session_id.clone(), f)),
                            Err(e) => {
                                log::warn!("[device] open audio file fail: {e}");
                            }
                        }
                    }
                    if let Some((_, f)) = audio_file.as_mut() {
                        let _ = f.write_all(&bytes).await;
                    }
                }

                let _ = self.app.emit(
                    EVT_AUDIO_CHUNK_META,
                    serde_json::json!({
                        "device_id": device_id,
                        "session_id": session_id,
                        "seq": seq,
                        "bytes": nbytes,
                        "ts_ms": now_ms(),
                    }),
                );

                // ack 给设备
                let ack = serde_json::json!({
                    "msg_id": uuid::Uuid::new_v4().to_string(),
                    "ts_ms": now_ms(),
                    "t": "audio_chunk_ack",
                    "session_id": session_id,
                    "seq": seq,
                });
                let _ = out.send(Message::Text(ack.to_string()));
            }
            // 其他业务消息：尽量构造 DeviceEvent；解析失败兜底 UnknownEvent
            _ => {
                let evt = build_device_event(device_id, kind, &v);
                self.emit_device_event(evt).await;
                if kind == "error" {
                    let code = v.get("code").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                    let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let _ = self.app.emit(
                        EVT_DEVICE_ERROR,
                        serde_json::json!({
                            "device_id": device_id,
                            "code": code,
                            "detail": detail,
                        }),
                    );
                }
            }
        }
    }

    async fn touch_last_seen(&self, device_id: &str) {
        if let Some(mut rec) = self.registry.get(device_id) {
            rec.last_seen_at_ms = now_ms();
            self.registry.upsert(rec);
        }
        if let Some(ch) = self.connections.lock().await.get_mut(device_id) {
            ch.last_seen_at_ms = now_ms();
        }
    }

    async fn emit_device_event(&self, evt: DeviceEvent) {
        // 取出 device_id 用于 payload；event 自身 #[serde(tag="t")]，包一层让前端按
        // { device_id, event } 取值，和契约一致。
        let device_id = device_id_of(&evt).to_string();
        let _ = self.app.emit(
            EVT_DEVICE_EVENT,
            serde_json::json!({ "device_id": device_id, "event": evt }),
        );
    }

    async fn emit_server_status(&self) {
        let s = self.status().await;
        let _ = self.app.emit(EVT_SERVER_STATUS, &s);
    }

    async fn emit_list_changed(&self) {
        let count = self.registry.list().len();
        let _ = self.app.emit(EVT_LIST_CHANGED, serde_json::json!({ "count": count }));
    }
}

// 取出 DeviceEvent 中的 device_id 字段——枚举每个 variant 都有，但用 match 太啰嗦，
// 序列化后再读 JSON 字段更省事（P0 性能不敏感）。
fn device_id_of(evt: &DeviceEvent) -> String {
    serde_json::to_value(evt)
        .ok()
        .and_then(|v| v.get("device_id").and_then(|x| x.as_str().map(String::from)))
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn short_label(device_id: &str) -> String {
    let suffix: String = device_id.chars().rev().take(4).collect::<String>().chars().rev().collect();
    format!("Mic {suffix}")
}

fn audio_dir(app: &AppHandle, device_id: &str) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("device-audio").join(device_id))
}

fn base64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s)
}

// 取本机首个非 loopback IPv4，给 ServerStatus.host 展示。失败回 None，由调用方兜底。
fn local_lan_ip() -> Option<String> {
    use std::net::{IpAddr, UdpSocket};
    // 用 UDP connect 到任意外部地址来取本机出口 IP；不实际发包。
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let addr = sock.local_addr().ok()?;
    match addr.ip() {
        IpAddr::V4(v4) => Some(v4.to_string()),
        IpAddr::V6(_) => None,
    }
}

async fn register_mdns(port: u16) -> anyhow::Result<(mdns_sd::ServiceDaemon, String)> {
    let daemon = mdns_sd::ServiceDaemon::new()?;
    let host = whoami::devicename().unwrap_or_else(|_| "openspeech".into());
    let suffix: String = host.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
    let instance = format!("OpenSpeech-Desktop-{}", if suffix.is_empty() { "host".into() } else { suffix });
    let ip = local_lan_ip().unwrap_or_else(|| "127.0.0.1".into());
    let host_name = format!("{instance}.local.");
    let txt: &[(&str, &str)] = &[("proto", "1.0.0"), ("pairing", "open")];
    let svc = mdns_sd::ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &instance,
        &host_name,
        ip.as_str(),
        port,
        txt,
    )?;
    daemon.register(svc)?;
    Ok((daemon, instance))
}

// 把入站业务消息映射到 DeviceEvent；不在 P0 优化的全部走 UnknownEvent。
fn build_device_event(device_id: &str, kind: &str, v: &serde_json::Value) -> DeviceEvent {
    use super::protocol::ButtonGestureKind;
    let did = device_id.to_string();
    match kind {
        "recording_state" => {
            let recording = v.get("recording").and_then(|x| x.as_bool()).unwrap_or(false);
            let session_id = v.get("session_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            DeviceEvent::RecordingStateChange { device_id: did, recording, session_id }
        }
        "audio_level" => {
            let rms_db = v.get("rms_db").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
            let clipping = v.get("clipping").and_then(|x| x.as_bool()).unwrap_or(false);
            let silent_so_far = v.get("silent_so_far").and_then(|x| x.as_bool()).unwrap_or(false);
            DeviceEvent::AudioLevel { device_id: did, rms_db, clipping, silent_so_far }
        }
        "battery" => {
            let pct = v.get("pct").and_then(|x| x.as_u64()).unwrap_or(0) as u8;
            // 简单 tier 映射，不细分 deep_sleep 等
            let tier = if pct <= 10 {
                super::protocol::BatteryTier::Critical
            } else if pct <= 20 {
                super::protocol::BatteryTier::Low
            } else {
                super::protocol::BatteryTier::Healthy
            };
            DeviceEvent::BatteryLevelChanged { device_id: did, pct, tier }
        }
        "text_result" => {
            // 设备主动回报（少见），结构与 desktop->device 同
            let info = TextResultInfo {
                session_id: v.get("session_id").and_then(|x| x.as_str()).unwrap_or("").into(),
                text: v.get("text").and_then(|x| x.as_str()).unwrap_or("").into(),
                delivery_mode: super::protocol::DeliveryMode::DisplayOnly,
                target_app: v.get("target_app").and_then(|x| x.as_str()).unwrap_or("").into(),
                language_detected: v.get("language_detected").and_then(|x| x.as_str()).unwrap_or("").into(),
            };
            DeviceEvent::TextResult { device_id: did, info }
        }
        "ota_progress" => {
            let percent = v.get("percent").and_then(|x| x.as_u64()).unwrap_or(0) as u8;
            let est = v.get("estimated_remaining_ms").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            DeviceEvent::OtaProgress { device_id: did, percent, estimated_remaining_ms: est }
        }
        "channel_status" => {
            let ble_up = v.get("ble_up").and_then(|x| x.as_bool()).unwrap_or(false);
            let wifi_up = v.get("wifi_up").and_then(|x| x.as_bool()).unwrap_or(true);
            let status = super::event::ChannelStatusEvent {
                ble_up,
                wifi_up,
                ble_rtt_ms: v.get("ble_rtt_ms").and_then(|x| x.as_u64()).unwrap_or(0) as u16,
                wifi_rtt_ms: v.get("wifi_rtt_ms").and_then(|x| x.as_u64()).unwrap_or(0) as u16,
                wifi_rssi: v.get("wifi_rssi").and_then(|x| x.as_i64()).unwrap_or(0) as i8,
            };
            DeviceEvent::ChannelChange { device_id: did, status }
        }
        "gesture" => {
            let g = v.get("gesture").and_then(|x| x.as_str()).unwrap_or("");
            let gesture = match g {
                "tap" => ButtonGestureKind::Tap,
                "press_hold" => ButtonGestureKind::PressHold,
                "short_release" => ButtonGestureKind::ShortRelease,
                "double_click" => ButtonGestureKind::DoubleClick,
                "long_abort" => ButtonGestureKind::LongAbort,
                _ => ButtonGestureKind::Tap,
            };
            DeviceEvent::Gesture { device_id: did, gesture }
        }
        _ => DeviceEvent::UnknownEvent {
            device_id: did,
            wire_tag: kind.to_string(),
            json_payload: v.to_string(),
        },
    }
}

// 让上游借引用避免重复 unused 警告
#[allow(dead_code)]
fn _silence_channel_type_unused(_c: &super::protocol::ChannelType) {}
