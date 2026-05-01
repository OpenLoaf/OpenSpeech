// 系统级空闲秒数（自上次键鼠输入以来）。供 updater 调度器在 AUTO 策略下判断"用户
// 是否长时间无操作"使用——只看 OS 级输入而不是窗口 focus，跨虚拟桌面 / 全屏其他 app
// 也能正确判定。
//
// macOS：CGEventSourceSecondsSinceLastEventType + kCGAnyInputEventType（0xFFFFFFFF）。
// Windows：GetLastInputInfo() 返回的 dwTime 是 32 位 GetTickCount，溢出后能通过 wrapping_sub
//          得到正差值。
// Linux：可靠跨发行版的 API 太少（X11 有 XScreenSaver 扩展，Wayland 各 compositor 各搞各的），
//        统一返回 Err，前端在 AUTO 策略下视作"无法判定" → 不触发自动安装。

#[cfg(target_os = "macos")]
mod platform {
    type CGEventSourceStateID = u32;
    type CGEventType = u32;
    const K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE: CGEventSourceStateID = 0;
    const K_CG_ANY_INPUT_EVENT_TYPE: CGEventType = 0xFFFFFFFF;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(
            source_state: CGEventSourceStateID,
            event_type: CGEventType,
        ) -> f64;
    }

    pub fn idle_seconds() -> Result<u64, String> {
        let s = unsafe {
            CGEventSourceSecondsSinceLastEventType(
                K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE,
                K_CG_ANY_INPUT_EVENT_TYPE,
            )
        };
        if s.is_finite() && s >= 0.0 {
            Ok(s as u64)
        } else {
            Err(format!("CGEventSource returned invalid value: {s}"))
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::mem::size_of;

    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
        fn GetTickCount() -> u32;
    }

    pub fn idle_seconds() -> Result<u64, String> {
        let mut info = LastInputInfo {
            cb_size: size_of::<LastInputInfo>() as u32,
            dw_time: 0,
        };
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if ok == 0 {
            return Err("GetLastInputInfo failed".to_string());
        }
        let now = unsafe { GetTickCount() };
        let delta_ms = now.wrapping_sub(info.dw_time);
        Ok((delta_ms / 1000) as u64)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    pub fn idle_seconds() -> Result<u64, String> {
        Err("idle detection not supported on linux".to_string())
    }
}

#[tauri::command]
pub fn system_idle_seconds() -> Result<u64, String> {
    platform::idle_seconds()
}
