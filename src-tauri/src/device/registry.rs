// 已绑定设备表 — 多设备 + 单激活 + JSON 文件持久化。
//
// 同步签名：trait 方法都阻塞同步，JSON 整盘重写在小规模（≤ 数十台）下成本可忽略。
// 进程内序列化通过 std::sync::Mutex 保证 thread-safety。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::protocol::DeviceId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub device_id: DeviceId,
    pub label: String,
    pub bound_user_id: String,
    pub token_seq: u32,
    pub last_protocol_version: String,
    pub last_firmware_semver: String,
    pub first_paired_at_ms: u64,
    pub last_seen_at_ms: u64,
    // 桌面端首次配对时记下的对端证书指纹（TOFU）
    pub peer_cert_sha256: Option<String>,
    // 多设备单激活：同一时刻最多一个 record `is_active=true`
    #[serde(default)]
    pub is_active: bool,
}

pub trait DeviceRegistry: Send + Sync {
    fn get(&self, device_id: &str) -> Option<DeviceRecord>;
    fn upsert(&self, record: DeviceRecord);
    fn remove(&self, device_id: &str);
    fn list(&self) -> Vec<DeviceRecord>;
    /// 把指定 device_id 设为唯一 active；其它一律清掉 is_active。
    /// 返回 true 表示该 id 存在并已激活；false 表示 id 不存在（不会改其它 record）。
    fn set_active(&self, device_id: &str) -> bool;
    /// 当前 active record 的 id（如果有）
    fn active_id(&self) -> Option<DeviceId>;
}

// ──────────────── In-memory ────────────────

pub struct InMemoryRegistry {
    inner: Mutex<HashMap<DeviceId, DeviceRecord>>,
}

impl InMemoryRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceRegistry for InMemoryRegistry {
    fn get(&self, device_id: &str) -> Option<DeviceRecord> {
        self.inner.lock().ok()?.get(device_id).cloned()
    }

    fn upsert(&self, record: DeviceRecord) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(record.device_id.clone(), record);
        }
    }

    fn remove(&self, device_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(device_id);
        }
    }

    fn list(&self) -> Vec<DeviceRecord> {
        self.inner
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    fn set_active(&self, device_id: &str) -> bool {
        let Ok(mut map) = self.inner.lock() else {
            return false;
        };
        if !map.contains_key(device_id) {
            return false;
        }
        for (id, rec) in map.iter_mut() {
            rec.is_active = id == device_id;
        }
        true
    }

    fn active_id(&self) -> Option<DeviceId> {
        let map = self.inner.lock().ok()?;
        map.values()
            .find(|r| r.is_active)
            .map(|r| r.device_id.clone())
    }
}

// ──────────────── JSON 文件持久化 ────────────────

/// `devices.json` 文件持久化版本。结构等同 InMemoryRegistry，每次 mutation 整盘重写。
pub struct PersistentRegistry {
    inner: Mutex<HashMap<DeviceId, DeviceRecord>>,
    path: PathBuf,
}

impl PersistentRegistry {
    /// 从 path 读取（不存在则 empty）。父目录不存在会尝试创建一次。
    pub fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let inner = load_from_disk(&path).unwrap_or_default();
        Self {
            inner: Mutex::new(inner),
            path,
        }
    }

    fn flush(&self, map: &HashMap<DeviceId, DeviceRecord>) {
        match serde_json::to_vec_pretty(&map.values().collect::<Vec<_>>()) {
            Ok(bytes) => {
                if let Err(e) = atomic_write(&self.path, &bytes) {
                    log::warn!("[registry] flush failed: {e}");
                }
            }
            Err(e) => log::warn!("[registry] serialize failed: {e}"),
        }
    }
}

impl DeviceRegistry for PersistentRegistry {
    fn get(&self, device_id: &str) -> Option<DeviceRecord> {
        self.inner.lock().ok()?.get(device_id).cloned()
    }

    fn upsert(&self, record: DeviceRecord) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        map.insert(record.device_id.clone(), record);
        self.flush(&map);
    }

    fn remove(&self, device_id: &str) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        map.remove(device_id);
        self.flush(&map);
    }

    fn list(&self) -> Vec<DeviceRecord> {
        self.inner
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    fn set_active(&self, device_id: &str) -> bool {
        let Ok(mut map) = self.inner.lock() else {
            return false;
        };
        if !map.contains_key(device_id) {
            return false;
        }
        for (id, rec) in map.iter_mut() {
            rec.is_active = id == device_id;
        }
        self.flush(&map);
        true
    }

    fn active_id(&self) -> Option<DeviceId> {
        let map = self.inner.lock().ok()?;
        map.values()
            .find(|r| r.is_active)
            .map(|r| r.device_id.clone())
    }
}

fn load_from_disk(path: &Path) -> Option<HashMap<DeviceId, DeviceRecord>> {
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return Some(HashMap::new());
    }
    // 兼容两种 schema：[record, …] 数组（当前）/ {device_id: record} 对象（早期）
    if let Ok(list) = serde_json::from_slice::<Vec<DeviceRecord>>(&bytes) {
        return Some(
            list.into_iter()
                .map(|r| (r.device_id.clone(), r))
                .collect(),
        );
    }
    serde_json::from_slice::<HashMap<DeviceId, DeviceRecord>>(&bytes).ok()
}

/// 原子写：先写 `<path>.tmp` 再 rename，避免崩溃时残留半文件。
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
