// 系统级 focused UI 元素是否可编辑文本——按下听写快捷键的瞬间 snapshot 一次，
// 录音 finalize 时若 = false 直接跳过 inject 走"复制最后转录"面板。silent fail
// （enigo 在 Finder/桌面/只读 web 区域 type 不抛错也写不进字）就此根治。
//
// 仅 macOS 真做检测：用 ApplicationServices 的 AXUIElementCreateSystemWide +
// AXFocusedUIElement → AXRole/AXSubrole 比对一组已知"可编辑"角色。Windows /
// Linux 暂返 None，调用方按"未知"保守处理（仍尝试注入）。

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_void};
    use std::ptr;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;
    type AXError = i32;

    const KCF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const AX_SUCCESS: AXError = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFStringCreateWithCString(
            alloc: CFTypeRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: i64,
            encoding: u32,
        ) -> u8;
        fn CFGetTypeID(cf: CFTypeRef) -> u64;
        fn CFStringGetTypeID() -> u64;
    }

    fn cfstr(s: &str) -> Option<CFStringRef> {
        let c = CString::new(s).ok()?;
        let r = unsafe {
            CFStringCreateWithCString(ptr::null(), c.as_ptr(), KCF_STRING_ENCODING_UTF8)
        };
        if r.is_null() { None } else { Some(r) }
    }

    fn cfstring_to_owned(s: CFStringRef) -> Option<String> {
        if s.is_null() {
            return None;
        }
        unsafe {
            if CFGetTypeID(s) != CFStringGetTypeID() {
                return None;
            }
        }
        let mut buf = [0i8; 256];
        let ok = unsafe {
            CFStringGetCString(
                s,
                buf.as_mut_ptr(),
                buf.len() as i64,
                KCF_STRING_ENCODING_UTF8,
            )
        };
        if ok == 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let bytes: Vec<u8> = buf[..len].iter().map(|&c| c as u8).collect();
        String::from_utf8(bytes).ok()
    }

    fn copy_attr_string(element: AXUIElementRef, key: &str) -> Option<String> {
        let key_cf = cfstr(key)?;
        let mut value: CFTypeRef = ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(element, key_cf, &mut value) };
        unsafe { CFRelease(key_cf) };
        if err != AX_SUCCESS || value.is_null() {
            return None;
        }
        let s = cfstring_to_owned(value);
        unsafe { CFRelease(value) };
        s
    }

    pub fn focus_is_editable() -> Option<bool> {
        log::info!("[focus] AX query enter");
        let system = unsafe { AXUIElementCreateSystemWide() };
        if system.is_null() {
            log::warn!("[focus] AXUIElementCreateSystemWide returned NULL");
            return None;
        }
        let focused_attr = match cfstr("AXFocusedUIElement") {
            Some(s) => s,
            None => {
                unsafe { CFRelease(system) };
                log::warn!("[focus] cfstr(AXFocusedUIElement) failed");
                return None;
            }
        };
        let mut focused: CFTypeRef = ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(system, focused_attr, &mut focused) };
        unsafe {
            CFRelease(focused_attr);
            CFRelease(system);
        }
        // 没拿到 focused 元素：可能是 AX 权限未授予 / 当前焦点是无障碍 API 看不到的
        // 私有 view（部分 Electron 早期版本 / 全屏游戏）。视为"未知"，调用方走旧路径。
        if err != AX_SUCCESS || focused.is_null() {
            log::warn!(
                "[focus] AXFocusedUIElement unavailable err={err} focused_null={} → return None (Unknown)",
                focused.is_null()
            );
            return None;
        }
        let role = copy_attr_string(focused, "AXRole");
        let subrole = copy_attr_string(focused, "AXSubrole");
        unsafe { CFRelease(focused) };

        // Chromium / Slack / VS Code / Cursor / Discord 这些 Electron 应用的真实
        // 输入框（无论是 <input>/<textarea> 还是 contenteditable div）AX 层都会暴
        // 露成 AXTextField / AXTextArea，命中此白名单。AXWebArea 是"焦点没在任何
        // 输入元素上"的网页正文兜底，正确算不可编辑。
        let editable_roles = [
            "AXTextField",
            "AXTextArea",
            "AXComboBox",
            "AXSearchField",
            "AXSecureTextField",
        ];
        let editable_subroles = ["AXTextEntryArea", "AXContentEditable"];

        let role_match = role
            .as_deref()
            .map(|r| editable_roles.iter().any(|x| *x == r))
            .unwrap_or(false);
        let subrole_match = subrole
            .as_deref()
            .map(|r| editable_subroles.iter().any(|x| *x == r))
            .unwrap_or(false);
        let editable = role_match || subrole_match;

        log::info!(
            "[focus] role={:?} subrole={:?} role_match={} subrole_match={} → editable={}",
            role.as_deref(),
            subrole.as_deref(),
            role_match,
            subrole_match,
            editable
        );
        Some(editable)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn focus_is_editable() -> Option<bool> {
        None
    }
}

/// Some(true) = 当前系统焦点是文本输入区域；
/// Some(false) = 焦点存在但不是文本输入；
/// None = 拿不到结论（macOS AX 权限缺失 / Win / Linux）。调用方按可注入处理。
#[tauri::command]
pub fn focus_is_editable_cmd() -> Option<bool> {
    let v = imp::focus_is_editable();
    log::info!("[focus] focus_is_editable_cmd → {:?}", v);
    v
}
