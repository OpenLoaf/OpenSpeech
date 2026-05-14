# Desktop-as-Server Contract（前后端契约）

> 本文是 P0 最小联测目标。Rust 后端（device 模块）与 React 前端（/devices 页面）
> 双方按此契约实现；任何字段名 / 事件名变化必须先改本文再改两边代码。

## 目标场景

ESP32 设备作为客户端连入桌面端（桌面端 = WS 服务器）。
**先打通最小回环**：设备 → 桌面端 WS → 握手 → 心跳 → 上传 audio_chunk → 桌面端 stub 写盘 → 手动下发 text_result。

P0 **不做**：BLE 配网（中央角色实现太重）、SPAKE2 + AEAD（暂明文 ws://）、OTA、Quarantine、持久化（in-mem registry）。
P0 **要做**：mDNS 广播、hello/hello_ack 握手、ping/pong 心跳、audio_chunk 接收落盘、手工 text_result 下发、UI 全套。

---

## WS Server

- 监听地址：默认 `0.0.0.0:17878`，可被 store key `device.server.port` 覆盖
- 路径：`ws://<host>:17878/openspeech-mic`
- query：`device_id=<id>&token=<token>`（P0 token 非空即通过；标记 DEV mode）
- 升级头（设备必带）：
  - `X-OpenSpeech-Protocol: 1.0.0`
  - `X-OpenSpeech-Firmware: 0.1.0`
  - `X-OpenSpeech-Device-Id: <id>`
  - `X-OpenSpeech-Device-Token: <opaque>`（P0 任意）
  - `X-OpenSpeech-Token-Seq: 0`

## mDNS 广播

- service type: `_openspeech-mic._tcp.local.`
- instance name: `OpenSpeech-Desktop-<machineSuffix>`（取 hostname 后 6 字节 hex）
- TXT: `proto=1.0.0`, `pairing=open`（P0）

---

## Tauri Commands

| 命令 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `device_server_status` | () | `ServerStatus` | 当前 server 状态（端口、是否运行、连接数等） |
| `device_server_start` | () | `Result<(), String>` | 启动 WS server + mDNS |
| `device_server_stop` | () | `Result<(), String>` | 关停 WS + 撤销 mDNS |
| `device_list` | () | `DeviceRecord[]` | 全部已注册设备（在线 / 离线） |
| `device_get` | `device_id: String` | `DeviceRecord?` | 单设备详情 |
| `device_remove` | `device_id: String` | `Result<(), String>` | 移除一台设备（同时断开连接） |
| `device_clear_all` | () | `Result<(), String>` | 清空所有设备（开发期用） |
| `device_rename` | `{ device_id, label }` | `Result<(), String>` | 改 label（写回 registry） |
| `device_send_text` | `{ device_id, text, target_app? }` | `Result<(), String>` | 手动把 text_result 推给设备 |
| `device_push_ota` | `{ device_id, file_path, target_version }` | `Result<String, String>` | P0 stub：返回假 `offer_id`，并定期 emit OtaProgress（10% step）直到 100% |
| `device_ble_scan_start` | () | `Result<(), String>` | 起 BLE 中央角色扫描；过滤 OpenSpeech service UUID 与 `OpenSpeech-Mic-` name 前缀 |
| `device_ble_scan_stop` | () | `Result<(), String>` | 停扫描，已发现列表保留 |
| `device_ble_scan_state` | () | `BleScanState` | 当前扫描状态（含 adapter 是否就绪、错误） |
| `device_ble_discovered_list` | () | `DiscoveredBleDevice[]` | 已发现但未配对的设备列表（按 last_seen 倒序） |
| `device_ble_discovered_clear` | () | `Result<(), String>` | 清空已发现列表（开发期用） |

## DTO

```ts
type ServerStatus = {
  running: boolean;
  host: string;          // 显示给用户，默认 LAN ip
  port: number;
  mdns_instance: string;
  cert_sha256: string | null; // P0 = null（明文 ws）
  connected_count: number;
  started_at_ms: number | null;
};

type BleScanState = {
  scanning: boolean;
  adapter_present: boolean;
  adapter_name: string;
  last_error: string | null;
  discovered_count: number;
};

type DiscoveredBleDevice = {
  address: string;            // 平台原生地址，macOS 给的是 UUID 串
  local_name: string;
  rssi_dbm: number;
  last_seen_at_ms: number;
  matches_openspeech: boolean;
};

type DeviceRecord = {
  device_id: string;
  label: string;
  bound_user_id: string;       // P0 = ""（未接入 SaaS 鉴权）
  token_seq: number;
  last_protocol_version: string;
  last_firmware_semver: string;
  first_paired_at_ms: number;
  last_seen_at_ms: number;
  peer_cert_sha256: string | null;

  // 运行态（registry 外注入到 list 返回）
  online: boolean;
  channel: "ble" | "wifi" | null;
  rssi_dbm: number | null;
  rtt_ms: number | null;
  battery_pct: number | null;
  battery_tier: "normal" | "low" | "critical" | "no_record" | "deep_sleep" | null;
  last_text_result: string | null;
  last_text_result_at_ms: number | null;
};
```

---

## Tauri Events（统一前缀 `openspeech://device-*`）

所有 payload 都带 `device_id`（除非 server 级事件）。

| 事件名 | payload | 触发时机 |
|---|---|---|
| `openspeech://device-server-status` | `ServerStatus` | start/stop/连接数变 |
| `openspeech://device-connected` | `{ device_id, channel, peer_addr, protocol_version, firmware }` | hello 成功 |
| `openspeech://device-disconnected` | `{ device_id, channel, reason }` | TCP close / 心跳超时 |
| `openspeech://device-event` | `{ device_id, event: DeviceEvent }` | **通用事件**——把 device/event.rs 的 `DeviceEvent` 直接转发 |
| `openspeech://device-error` | `{ device_id, code: number, detail: string }` | 错误码 1xxx–7xxx |
| `openspeech://device-audio-chunk-meta` | `{ device_id, session_id, seq, bytes, ts_ms }` | 每收一帧 audio_chunk |
| `openspeech://device-list-changed` | `{ count }` | upsert/remove 后 |
| `openspeech://ble-scan-state-changed` | `BleScanState` | 扫描开关 / 发现数 / 错误变化 |
| `openspeech://ble-device-discovered` | `DiscoveredBleDevice` | 首次发现一台新设备时（重复刷不再 emit） |

`DeviceEvent` 序列化形态见 `device/event.rs`：`#[serde(tag = "t", rename_all = "snake_case")]`，前端按 `event.t` switch 分发。

---

## P0 最小联测序列（设备端视角）

1. 设备扫 mDNS `_openspeech-mic._tcp.local.` → 拿到 host:17878
2. 设备发起 `ws://host:17878/openspeech-mic?device_id=X&token=DEV` 带升级头
3. 桌面端 accept，记录 `peer_addr`，等设备发 `hello`
4. 桌面端校验 protocol major（=1）；通过 → 回 `hello_ack`；不通过 → 回 `protocol_incompatible` + close
5. 桌面端定时发 `ping`，设备回 `pong`；设备也可发 `ping`，桌面端回 `pong`
6. 设备发 `recording_state_change { recording: true }` → 桌面端 emit `device-event`，UI 显示「录音中」
7. 设备分片发 `audio_chunk`（PCM 16k/16bit/mono，<=4KB/帧）→ 桌面端写 `~/.../device-audio/<device_id>/<session_id>.pcm` + emit `device-audio-chunk-meta`
8. 设备发 `recording_state_change { recording: false }` → 桌面端关文件
9. 用户在 UI 点「发送文本」→ 调 `device_send_text` → 桌面端发 `text_result` 给设备

---

## 前后端边界

- **错误码定义在 Rust**（`device/error_codes.rs`，已存在 1xxx–7xxx）；前端只读不改
- **事件类型定义在 Rust**（`device/event.rs`）；前端写一份 `.d.ts` 镜像（手工同步）
- **i18n**：所有用户可见文案在前端 `i18n/zh.json` / `i18n/en.json`；Rust 不嵌文本
- **持久化**：P0 全 in-mem；P1 接 tauri-plugin-sql

## P1+ 待办（本契约不含）

- BLE 配网（中央角色 + SPAKE2）
- TLS + TOFU pinning
- OTA 真实推送（A/B 分区 + Ed25519）
- Quarantine 状态机完整实现
- audio_chunk → STT 桥（接现有 `src-tauri/src/stt` / `asr`）
- SQLite registry
