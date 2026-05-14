// 单桌面多设备 active_device 锁
// 同时只允许一台设备占用录音/注入；其他设备发 SessionClaim 时回 LockDenied

use std::sync::Mutex;
use std::time::Instant;

use super::protocol::DeviceId;

#[derive(Debug, Clone)]
pub struct LockHolder {
    pub device_id: DeviceId,
    pub device_label: String,
    pub acquired_at: Instant,
}

pub struct ConcurrentLock {
    inner: Mutex<Option<LockHolder>>,
}

impl ConcurrentLock {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    // 抢锁；已有占用方且不是自己时返回当前占用方
    pub fn try_acquire(&self, holder: LockHolder) -> Result<(), LockHolder> {
        let mut slot = self
            .inner
            .lock()
            .expect("concurrent_lock poisoned — desktop process should restart");
        match &*slot {
            Some(existing) if existing.device_id != holder.device_id => Err(existing.clone()),
            _ => {
                *slot = Some(holder);
                Ok(())
            }
        }
    }

    // 释放锁，仅占用方自己可释放
    pub fn release(&self, device_id: &DeviceId) {
        if let Ok(mut slot) = self.inner.lock() {
            if slot.as_ref().map(|h| &h.device_id) == Some(device_id) {
                *slot = None;
            }
        }
    }

    pub fn current(&self) -> Option<LockHolder> {
        self.inner.lock().ok().and_then(|s| s.clone())
    }
}

impl Default for ConcurrentLock {
    fn default() -> Self {
        Self::new()
    }
}
