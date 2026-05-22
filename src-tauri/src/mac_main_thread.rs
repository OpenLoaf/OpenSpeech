// macOS 主线程同步派发 helper。
//
// macOS 26.2 给 Text Input Source Manager API 上了主线程断言：从后台线程调
// TISCopyCurrent* / TISSelectInputSource / TISGetInputSourceProperty 会 SIGTRAP
// 闪退。tauri 2 的 #[command] 在 invoke worker pool 上跑，不一定是主线程，所以
// 任何 TIS 调用必须经过本 helper 派回 main queue。
//
// 实现走 libdispatch 的 dispatch_sync_f + _dispatch_main_q（libSystem.dylib 导出
// 的 main queue 符号），不引入 dispatch / objc2_dispatch 依赖。
//
// 仅 macOS 编译；其它平台不编。

#![cfg(target_os = "macos")]

use std::os::raw::c_void;

#[link(name = "System", kind = "dylib")]
unsafe extern "C" {
    fn pthread_main_np() -> i32;
    fn dispatch_sync_f(
        queue: *mut c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
    static _dispatch_main_q: c_void;
}

#[inline]
pub fn is_main_thread() -> bool {
    unsafe { pthread_main_np() != 0 }
}

#[inline]
fn main_queue() -> *mut c_void {
    unsafe { &_dispatch_main_q as *const c_void as *mut c_void }
}

/// 把闭包派发到主线程同步执行，原线程阻塞直到结果回来。
/// 当前已在主线程时直接调闭包（dispatch_sync 到自己所在 queue 会死锁）。
pub fn run_sync<R, F>(f: F) -> R
where
    R: Send,
    F: FnOnce() -> R + Send,
{
    if is_main_thread() {
        return f();
    }

    struct Slot<R, F> {
        f: Option<F>,
        r: Option<R>,
    }

    let mut slot: Slot<R, F> = Slot {
        f: Some(f),
        r: None,
    };

    extern "C" fn trampoline<R, F: FnOnce() -> R>(ctx: *mut c_void) {
        let slot = unsafe { &mut *(ctx as *mut Slot<R, F>) };
        if let Some(f) = slot.f.take() {
            slot.r = Some(f());
        }
    }

    unsafe {
        dispatch_sync_f(
            main_queue(),
            &mut slot as *mut _ as *mut c_void,
            trampoline::<R, F>,
        );
    }

    slot.r
        .take()
        .expect("dispatch_sync_f trampoline did not fill result")
}
