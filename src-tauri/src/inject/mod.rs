// 文本注入：两条路径
//   - inject_paste：剪贴板 + Cmd/Ctrl+V，整段一次贴入。用作末尾兜底 / 失败回退。
//   - inject_type：enigo text() 直接键入 Unicode。流式逐字符输出走这条，
//     不污染用户剪贴板、不被 IME 拦截。
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

use enigo::{Direction, Enigo, InputError, Key, Keyboard, Settings};

#[cfg(target_os = "windows")]
const WIN_TYPE_CHUNK_CHARS: usize = 4;
#[cfg(target_os = "windows")]
const WIN_TYPE_CHUNK_SLEEP_MS: u64 = 8;

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

#[tauri::command]
pub fn inject_paste() -> Result<(), String> {
    log::info!("[inject] paste enter");
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| {
        log::error!("[inject] paste enigo init failed: {e}");
        e.to_string()
    })?;

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
