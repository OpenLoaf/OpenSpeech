// 文本注入：两条路径
//   - inject_paste：剪贴板 + Cmd/Ctrl+V，整段一次贴入。用作末尾兜底 / 失败回退。
//   - inject_type：enigo text() 直接键入 Unicode。流式逐字符输出走这条，
//     不污染用户剪贴板。
//
// 关于"静默失败"：
//   enigo 在 Windows 上走 SendInput + KEYEVENTF_UNICODE，目标进程权限更高
//   (UAC 管理员窗口)、UWP 沙盒、部分 IME 候选窗、游戏全屏独占等场景会**忽略**
//   这种 fake unicode key event，但 SendInput 自身返回成功——也就是说 enigo
//   不会抛错，前端 catch→paste fallback 触发不到。诊断这种"看起来成功但用户
//   屏幕上没字"的场景必须靠这里的 INFO 日志反推：会话开始/结束都打点，事后
//   对照用户截图就能确认 Rust 端是否真的发了 SendInput。
//
// 关于 Windows 上"前 N 个字到了，后面全丢"：
//   一次性把 ~50 个 KEYEVENTF_UNICODE 事件灌进 SendInput，系统消息队列容量
//   上限 / 目标应用 message pump 跟不上 / IME 输入区节流，**会静默丢弃后续
//   事件**。enigo 0.6.x 没有内置分块。这里 Windows 平台按 WIN_TYPE_CHUNK_CHARS
//   把段拆成小块、块之间 sleep WIN_TYPE_CHUNK_SLEEP_MS，让 pump 有时间消化。
//   实测中文 + 微信/浏览器/Office 输入框不再截断。其它平台无此问题，原速直发。
//
// 关于 Windows 中文 IME 把 ASCII 当拼音吃掉：
//   KEYEVENTF_UNICODE 对中文 / 全角标点等高位 Unicode 字符 IME 直接放行，但
//   ASCII 可见字符（A-Z a-z 0-9 ! ? . ,）会被搜狗 / 微软拼音 / QQ 拼音的
//   keyboard hook 当作拼音输入接收，激活候选词框，最终落屏内容是"选词后的
//   中文"。翻译模式英文段是重灾区。inject_type 入口检测到含 ASCII 可见字
//   符就 ImmSetOpenStatus(FALSE) 临时关 IME，离开 scope 由 Drop 还原，纯
//   中文段不动 IME（不闪图标）。
//
// 关于"纯中文段开头首字符被吞 / 双标点"：
//   即使段里全是中文，IME 在多段连续 inject 之间可能还停留在 composition
//   边缘态——上一段 commit 完候选窗未彻底关闭，下一段第一个 KEYEVENTF_UNICODE
//   字符会被当作 composition 续写吃掉，紧跟的全角标点触发智能标点策略再补
//   一个标点，屏幕上就是"首字消失 + 双逗号"。每个 segment 注入前发一次
//   ImmNotifyIME(NI_COMPOSITIONSTR, CPS_CANCEL) 强制清空 composition 缓冲，
//   IME 没在 composition 时是 no-op，开关状态 / 候选窗都不动，不闪图标。

use enigo::{Direction, Enigo, InputError, Key, Keyboard, Settings};

// macOS 注音 / 仓颉 / RIME / 搜狗 / 百度 这类强 composition IME 即便 composition 为空，
// 也会拦截字母键 keyDown 当作组字输入——Cmd+V 的 V 一旦进 IME，paste 就完全没发生
// 在目标 App 上，屏幕表现是 composition 高亮残留（视觉上像"全选"）。前端
// imeStatus.ts 的 BLOCKED_IME_PREFIXES 必须与此保持同步。
#[cfg(target_os = "macos")]
const MACOS_BLOCKING_IME_PREFIXES: &[&str] = &[
    "com.apple.inputmethod.TCIM.",
    "com.apple.inputmethod.TYIM.",
    "im.rime.inputmethod.",
    "com.sogou.",
    "com.baidu.",
];

#[cfg(target_os = "macos")]
mod ime_bypass {
    use std::os::raw::{c_char, c_void};
    use std::ptr;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type TISInputSourceRef = *const c_void;
    type OSStatus = i32;

    const KCF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn TISCopyCurrentKeyboardInputSource() -> TISInputSourceRef;
        fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> TISInputSourceRef;
        fn TISSelectInputSource(source: TISInputSourceRef) -> OSStatus;
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

    fn cfstring_to_string(s: CFStringRef) -> Option<String> {
        if s.is_null() {
            return None;
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

    fn input_source_id(src: TISInputSourceRef) -> Option<String> {
        let id_cf = unsafe { TISGetInputSourceProperty(src, kTISPropertyInputSourceID) };
        cfstring_to_string(id_cf)
    }

    fn should_bypass(id: &str) -> bool {
        super::MACOS_BLOCKING_IME_PREFIXES
            .iter()
            .any(|p| id.starts_with(p))
    }

    pub struct Guard {
        previous: TISInputSourceRef,
        previous_id: String,
    }

    impl Guard {
        /// 当前 IME 命中阻塞名单时，临时切到 ASCII-capable 键盘布局（通常是
        /// com.apple.keylayout.ABC / US），返回 Guard；Drop 时还原。
        ///
        /// 切换不是同步原子的——TIS 切换是异步派发给 IM 服务的，需要一小段 sleep
        /// 让事件循环把 keyboard state 真切换过去，否则随后的 Cmd+V 仍可能被旧
        /// IME 拦截。
        pub fn enter() -> Option<Self> {
            let prev = unsafe { TISCopyCurrentKeyboardInputSource() };
            if prev.is_null() {
                return None;
            }
            let Some(prev_id) = input_source_id(prev) else {
                unsafe { CFRelease(prev) };
                return None;
            };
            if !should_bypass(&prev_id) {
                unsafe { CFRelease(prev) };
                return None;
            }

            let ascii = unsafe { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() };
            if ascii.is_null() {
                log::warn!("[inject] ime bypass: TISCopyCurrentASCIICapableKeyboardLayoutInputSource returned null");
                unsafe { CFRelease(prev) };
                return None;
            }
            let ascii_id = input_source_id(ascii).unwrap_or_else(|| "<unknown>".into());

            let status = unsafe { TISSelectInputSource(ascii) };
            unsafe { CFRelease(ascii) };
            if status != 0 {
                log::warn!(
                    "[inject] ime bypass: TISSelectInputSource(ascii) status={status} prev={prev_id}"
                );
                unsafe { CFRelease(prev) };
                return None;
            }

            std::thread::sleep(std::time::Duration::from_millis(40));
            log::info!(
                "[inject] ime bypass enter: prev={prev_id} → ascii={ascii_id}"
            );
            Some(Self {
                previous: prev,
                previous_id: prev_id,
            })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            // paste 已经发出去了，给目标 App 一点时间消化 Cmd+V，再把 IME 切回去，
            // 否则用户回到输入框继续敲字时可能仍是英文键盘。
            std::thread::sleep(std::time::Duration::from_millis(60));
            let status = unsafe { TISSelectInputSource(self.previous) };
            if status != 0 {
                log::warn!(
                    "[inject] ime bypass restore: TISSelectInputSource(prev={}) status={status}",
                    self.previous_id
                );
            } else {
                log::info!("[inject] ime bypass restore ok: {}", self.previous_id);
            }
            unsafe { CFRelease(self.previous) };
            self.previous = ptr::null();
        }
    }
}

#[cfg(target_os = "windows")]
const WIN_TYPE_CHUNK_CHARS: usize = 4;
#[cfg(target_os = "windows")]
const WIN_TYPE_CHUNK_SLEEP_MS: u64 = 8;

#[cfg(target_os = "windows")]
mod win_ime {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::Ime::{
        CPS_CANCEL, HIMC, ImmGetContext, ImmGetOpenStatus, ImmNotifyIME, ImmReleaseContext,
        ImmSetOpenStatus, NI_COMPOSITIONSTR,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    pub struct ImeGuard {
        hwnd: HWND,
        himc: HIMC,
        was_open: bool,
    }

    impl ImeGuard {
        pub fn disable() -> Option<Self> {
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.is_null() {
                    return None;
                }
                let himc = ImmGetContext(hwnd);
                if himc.is_null() {
                    return None;
                }
                let was_open = ImmGetOpenStatus(himc) != 0;
                if was_open {
                    ImmSetOpenStatus(himc, 0);
                }
                Some(Self {
                    hwnd,
                    himc,
                    was_open,
                })
            }
        }
    }

    impl Drop for ImeGuard {
        fn drop(&mut self) {
            unsafe {
                if self.was_open {
                    ImmSetOpenStatus(self.himc, 1);
                }
                ImmReleaseContext(self.hwnd, self.himc);
            }
        }
    }

    pub fn cancel_composition() {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return;
            }
            let himc = ImmGetContext(hwnd);
            if himc.is_null() {
                return;
            }
            ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
            ImmReleaseContext(hwnd, himc);
        }
    }
}

#[cfg(target_os = "windows")]
fn text_has_ime_risk(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_graphic())
}

/// 截取前 N 个 Unicode 标量，给日志做摘要——避免把整段转录原文打到日志里
/// 泄露隐私，又能在排错时确认"Rust 真的拿到了文本"。
fn log_excerpt(s: &str, n: usize) -> String {
    let preview: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{preview}…")
    } else {
        preview
    }
}

/// 把一段 segment 喂给 enigo.text()。Windows 上分块 + 块间 sleep 防止
/// SendInput 灌爆系统消息队列；其它平台直接一次性发出。
fn type_segment(enigo: &mut Enigo, segment: &str) -> Result<(), InputError> {
    #[cfg(target_os = "windows")]
    {
        win_ime::cancel_composition();
        let chars: Vec<char> = segment.chars().collect();
        for chunk in chars.chunks(WIN_TYPE_CHUNK_CHARS) {
            let s: String = chunk.iter().collect();
            enigo.text(&s)?;
            std::thread::sleep(std::time::Duration::from_millis(WIN_TYPE_CHUNK_SLEEP_MS));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        enigo.text(segment)
    }
}

// macOS 注音 / 拼音 / 仓颉 / 三方 Windows IME 在 active composition 期间会吞掉所有按键
// 事件——Cmd/Ctrl+V 也不例外。pasteAllAtOnce 在 IME blocked 路径下被 IME 异常处理 →
// composition 残留显示成高亮（视觉上像"全选"）+ paste 内容没真正落地。在 Cmd+V 之前
// 发一次 RightArrow：composition active 时 IME 会 commit 当前候选 + 光标右移；没
// composition 时仅光标右移 1（副作用最小，比 Esc 丢字 / Return 误发消息都稳）。
#[tauri::command]
pub fn inject_commit_ime() -> Result<(), String> {
    log::info!("[inject] commit_ime enter");
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| {
        log::error!("[inject] commit_ime enigo init failed: {e}");
        e.to_string()
    })?;
    enigo
        .key(Key::RightArrow, Direction::Click)
        .map_err(|e| {
            log::error!("[inject] commit_ime right click failed: {e}");
            e.to_string()
        })?;
    log::info!("[inject] commit_ime ok");
    Ok(())
}

#[tauri::command]
pub fn inject_paste() -> Result<(), String> {
    log::info!("[inject] paste enter");
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| {
        log::error!("[inject] paste enigo init failed: {e}");
        e.to_string()
    })?;

    // 注音 / 仓颉 / RIME / 搜狗 / 百度 这类 IME 即便空 composition 也会拦截 Cmd+V 的 V，
    // 把它当字母键吃进 composition；这里临时切到 ASCII 键盘布局让 Cmd+V 落地，Drop 时还原。
    #[cfg(target_os = "macos")]
    let _ime_guard = ime_bypass::Guard::enter();

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press).map_err(|e| {
        log::error!("[inject] paste modifier press failed: {e}");
        e.to_string()
    })?;
    enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| {
        log::error!("[inject] paste 'v' click failed: {e}");
        // 修饰键已经按下，直接 return 会留下卡住的 Ctrl/Cmd——尽力释放再回报错。
        let _ = enigo.key(modifier, Direction::Release);
        e.to_string()
    })?;
    enigo.key(modifier, Direction::Release).map_err(|e| {
        log::error!("[inject] paste modifier release failed: {e}");
        e.to_string()
    })?;
    log::info!("[inject] paste ok");
    Ok(())
}

#[tauri::command]
pub fn inject_type(text: String) -> Result<(), String> {
    if text.is_empty() {
        log::debug!("[inject] type empty input, no-op");
        return Ok(());
    }
    let char_count = text.chars().count();
    let byte_len = text.len();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let segments: Vec<&str> = normalized.split('\n').collect();
    let soft_returns = segments.len().saturating_sub(1);
    log::info!(
        "[inject] type enter chars={char_count} bytes={byte_len} segments={} soft_returns={soft_returns} preview={:?}",
        segments.len(),
        log_excerpt(&text, 16)
    );

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| {
        log::error!("[inject] type enigo init failed: {e}");
        e.to_string()
    })?;

    #[cfg(target_os = "windows")]
    let _ime_guard = if text_has_ime_risk(&text) {
        let g = win_ime::ImeGuard::disable();
        log::info!(
            "[inject] type ime guard {}",
            if g.is_some() { "disabled" } else { "skipped" }
        );
        g
    } else {
        None
    };

    // 按 \n 切段：段内走 text() 直接键入，段间发一次 Shift+Return 作为软换行——
    // Slack / Discord / Teams / WhatsApp / Telegram / iMessage / 飞书 / 钉钉 等
    // 都把裸 Return 绑成"发送"，Shift+Return 才是不触发发送的换行。
    for (idx, segment) in segments.iter().enumerate() {
        if idx > 0 {
            enigo.key(Key::Shift, Direction::Press).map_err(|e| {
                log::error!("[inject] type shift press failed at seg {idx}: {e}");
                e.to_string()
            })?;
            let click = enigo.key(Key::Return, Direction::Click);
            let release = enigo.key(Key::Shift, Direction::Release);
            click.map_err(|e| {
                log::error!("[inject] type return click failed at seg {idx}: {e}");
                let _ = enigo.key(Key::Shift, Direction::Release);
                e.to_string()
            })?;
            release.map_err(|e| {
                log::error!("[inject] type shift release failed at seg {idx}: {e}");
                e.to_string()
            })?;
        }
        if !segment.is_empty() {
            type_segment(&mut enigo, segment).map_err(|e| {
                log::error!(
                    "[inject] type text() failed at seg {idx}/{}: chars={} err={e}",
                    segments.len(),
                    segment.chars().count()
                );
                e.to_string()
            })?;
        }
    }
    log::info!("[inject] type ok chars={char_count}");
    Ok(())
}
