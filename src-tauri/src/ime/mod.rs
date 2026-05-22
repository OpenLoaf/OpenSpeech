// 当前激活的键盘输入源 id（macOS only）。给前端注入路径判断"程序伪造的 unicode
// keydown 会不会被 IME 拦截当作组字"：纯键盘布局（com.apple.keylayout.*）= 直通；
// 任何 IM kit input method（注音 / 拼音 / 仓颉 / 鼠须管 / 搜狗 …）= 拦截，
// streaming inject_type 必须降级整段 paste。
//
// Win / Linux 返回 None，前端按"未知"保守处理（保留 streaming）。

#[cfg(target_os = "macos")]
mod imp {
    use std::os::raw::{c_char, c_void};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type TISInputSourceRef = *const c_void;

    const KCF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn TISCopyCurrentKeyboardInputSource() -> TISInputSourceRef;
        fn TISGetInputSourceProperty(
            source: TISInputSourceRef,
            property_key: CFStringRef,
        ) -> CFTypeRef;
        static kTISPropertyInputSourceID: CFStringRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFStringGetCString(
            s: CFStringRef,
            buf: *mut c_char,
            buflen: i64,
            encoding: u32,
        ) -> u8;
    }

    pub fn active_ime_id() -> Option<String> {
        // macOS 26.2 给 TIS 上了主线程断言；从后台线程调会 SIGTRAP。整段 TIS 操作
        // 派回 main queue 同步执行，闭包只返 Send 的 Option<String>。
        crate::mac_main_thread::run_sync(|| {
            let src = unsafe { TISCopyCurrentKeyboardInputSource() };
            if src.is_null() {
                return None;
            }
            // TISGetInputSourceProperty 返回的 CFStringRef 是 borrowed，**不要** CFRelease。
            let id_cf = unsafe { TISGetInputSourceProperty(src, kTISPropertyInputSourceID) };
            if id_cf.is_null() {
                unsafe { CFRelease(src) };
                return None;
            }
            let mut buf = [0i8; 256];
            let ok = unsafe {
                CFStringGetCString(
                    id_cf,
                    buf.as_mut_ptr(),
                    buf.len() as i64,
                    KCF_STRING_ENCODING_UTF8,
                )
            };
            unsafe { CFRelease(src) };
            if ok == 0 {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            let bytes: Vec<u8> = buf[..len].iter().map(|&c| c as u8).collect();
            String::from_utf8(bytes).ok()
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn active_ime_id() -> Option<String> {
        None
    }
}

use std::sync::Mutex;
use std::sync::OnceLock;

fn last_seen_slot() -> &'static Mutex<Option<String>> {
    static SLOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

// macOS 26.2 给 Text Input Source Manager 上了主线程断言，TIS API 从后台线程
// 第二次调用会 SIGTRAP。所以本模块**只在** #[tauri::command] 路径上调 TIS——
// command handler 由 tauri invoke 路由进来，跑在合法上下文里；不要再起任何
// 后台 polling 线程调 TIS。
fn note_observed(curr: &Option<String>) {
    let mut slot = match last_seen_slot().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if slot.as_deref() != curr.as_deref() {
        log::info!(
            "[ime] switched: {:?} → {:?}",
            slot.as_deref(),
            curr.as_deref()
        );
        *slot = curr.clone();
    }
}

#[tauri::command]
pub fn active_ime_id_cmd() -> Option<String> {
    let v = imp::active_ime_id();
    note_observed(&v);
    v
}
