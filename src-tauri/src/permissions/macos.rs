// macOS 隐私权限实测 —— 直接走系统 API，避免 mock 误报。
//
// - 麦克风：[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]
// - 辅助功能：AXIsProcessTrustedWithOptions(NULL)（ApplicationServices）
// - 输入监控：IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)（IOKit）
//
// **request_* 已迁移到 tauri-plugin-macos-permissions**——本文件只负责
// "查询 + 注册（IOHIDRequestAccess）+ 重置（tccutil）+ 跳转设置"，
// 麦克风 / 辅助功能的请求由 plugin 用 Apple 官方 API 完成。
//
// 几个 FFI 注意点（之前曾导致检测误报）：
//   1. 苹果 `Boolean` 类型是 `unsigned char`，FFI 直接绑成 Rust `bool` 在
//      值非 0/1 时是 UB。改用 `u8` 收下后比较，行为可定义。
//   2. dev 模式下 `pnpm tauri dev` 每次重新构建都会让 macOS TCC 把
//      "OpenSpeech 已勾选"的条目视为另一个签名身份——表面上系统设置里仍
//      勾着，但 AXIsProcessTrusted/IOHIDCheckAccess 都读到未授权。这不是
//      代码 bug，是 TCC 与 ad-hoc 签名的固有冲突；缓解：tauri.conf.json 的
//      `bundle.macOS.signingIdentity = "-"` 让 dev 也走稳定的 ad-hoc 签名。

use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    /// 返回 1 表示已加入辅助功能列表且勾选；其它值（0）视为未授权。
    /// `options` 传 NULL 即等同 `AXIsProcessTrusted()` 但不做 prompt。
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> u8;
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOHIDCheckAccess(request: u32) -> u32;
    fn IOHIDRequestAccess(request: u32) -> u8;
}

// kIOHIDRequestTypeListenEvent —— 监听全局键盘 / 鼠标事件需要的请求类型。
const IOHID_REQUEST_LISTEN_EVENT: u32 = 1;

// AVAuthorizationStatus
const AV_NOT_DETERMINED: i64 = 0;
const AV_RESTRICTED: i64 = 1;
const AV_DENIED: i64 = 2;
const AV_AUTHORIZED: i64 = 3;

// kIOHIDAccessType
const IOHID_GRANTED: u32 = 0;
const IOHID_DENIED: u32 = 1;
// 其它值（如 2 unknown）一律按 notDetermined 处理。

unsafe fn ns_string(s: &str) -> *mut Object {
    let cls = class!(NSString);
    let bytes = s.as_ptr();
    let len = s.len();
    let nsutf8: u64 = 4; // NSUTF8StringEncoding
    unsafe {
        let alloc: *mut Object = msg_send![cls, alloc];
        msg_send![
            alloc,
            initWithBytes: bytes
            length: len
            encoding: nsutf8
        ]
    }
}

pub fn microphone_status() -> String {
    unsafe {
        let cls = class!(AVCaptureDevice);
        let media = ns_string("soun");
        let status: i64 = msg_send![cls, authorizationStatusForMediaType: media];
        let _: () = msg_send![media, release];
        match status {
            AV_NOT_DETERMINED => "notDetermined",
            AV_RESTRICTED => "restricted",
            AV_DENIED => "denied",
            AV_AUTHORIZED => "granted",
            _ => "unknown",
        }
        .to_string()
    }
}

pub fn accessibility_status() -> String {
    // options=NULL 等价 AXIsProcessTrusted()，但 FFI 类型用 u8 避免 Rust bool UB。
    let trusted = unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) };
    if trusted != 0 {
        "granted".into()
    } else {
        // macOS 没有 "notDetermined" 概念给辅助功能——只有 prompt 过一次的"加入列表"
        // 与"未加入列表"。两者都按 denied 上报，UI 提示用户去系统设置勾选即可。
        "denied".into()
    }
}

pub fn input_monitoring_status() -> String {
    let v = unsafe { IOHIDCheckAccess(IOHID_REQUEST_LISTEN_EVENT) };
    match v {
        IOHID_GRANTED => "granted".into(),
        IOHID_DENIED => "denied".into(),
        _ => "notDetermined".into(),
    }
}

/// 请求输入监控权限：调 IOHIDRequestAccess 即可——首次调用时 macOS 弹窗，
/// 后续调用为 no-op。**重要副作用**：这是把 OpenSpeech 写入系统设置「输入监控」
/// 列表的唯一可靠方式——只调 IOHIDCheckAccess 不会注册 App，导致用户打开系统
/// 设置时根本看不到 OpenSpeech 这一条可勾选项。所以前端无论当前状态是
/// notDetermined / denied / unknown 都应当先调一次本函数再 open_settings。
///
/// **plugin 不暴露此 API**：tauri-plugin-macos-permissions 的
/// `request_input_monitoring_permission` 只 `open` 系统设置 URL，
/// 不调 IOHIDRequestAccess。所以这一条仍由我们自己保留。
pub fn request_input_monitoring() {
    unsafe {
        IOHIDRequestAccess(IOHID_REQUEST_LISTEN_EVENT);
    }
}

pub fn open_settings(kind: &str) {
    use std::process::Command;
    let url = match kind {
        "microphone" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        "input-monitoring" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy",
    };
    let _ = Command::new("open").arg(url).spawn();
}

/// 重置 OpenSpeech 在 TCC 中的所有相关权限条目。
///
/// 触发场景：用户两次构建之间签名身份不一致（dev 反复重编 / release 没有
/// 稳定 Developer ID 的 ad-hoc 签名都会变化），TCC 把现进程视为"未在列表中的
/// 另一个 App"——即便系统设置 UI 仍能看到 OpenSpeech 开关 ON。
///
/// `tccutil reset <service> <bundle-id>` 把指定服务下与 bundle 相关的所有条目
/// 删除，相当于把 App 从该权限列表里清掉；下次再请求时按当前签名重新登记。
/// 服务名取自 Apple 文档：Accessibility / ListenEvent / Microphone（与
/// Privacy_* URL 不同）。失败（极少见，可能因 SIP 限制）只打日志，不传给前端。
pub fn reset_tcc(bundle_id: &str) {
    for service in ["Accessibility", "ListenEvent", "Microphone"] {
        run_tccutil_reset(service, bundle_id);
    }
}

/// 单 service 精细重置。用于"按下『去系统设置』时只清当前权限的旧条目"，
/// 避免一次性把麦克风 / 辅助功能 / 输入监控全部 reset 了——尤其当用户已经
/// 勾选了某些权限但只对一个权限存在签名漂移问题时，只清坏的那一条最干净。
pub fn reset_tcc_one(bundle_id: &str, kind: &str) {
    let service = match kind {
        "microphone" => "Microphone",
        "accessibility" => "Accessibility",
        "input-monitoring" => "ListenEvent",
        _ => {
            eprintln!("[permissions] reset_tcc_one: unknown kind {kind:?}, skip");
            return;
        }
    };
    run_tccutil_reset(service, bundle_id);
}

fn run_tccutil_reset(service: &str, bundle_id: &str) {
    use std::process::Command;
    let status = Command::new("tccutil")
        .arg("reset")
        .arg(service)
        .arg(bundle_id)
        .status();
    match status {
        Ok(s) if s.success() => {
            eprintln!("[permissions] tccutil reset {service} {bundle_id} OK");
        }
        Ok(s) => {
            eprintln!(
                "[permissions] tccutil reset {service} {bundle_id} exited with {s}"
            );
        }
        Err(e) => {
            eprintln!("[permissions] tccutil reset {service} {bundle_id} failed: {e}");
        }
    }
}
