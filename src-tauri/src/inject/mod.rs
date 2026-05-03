// 文本注入：两条路径
//   - inject_paste：剪贴板 + Cmd/Ctrl+V，整段一次贴入。用作末尾兜底 / 失败回退。
//   - inject_type：enigo text() 直接键入 Unicode。流式逐字符输出走这条，
//     不污染用户剪贴板、不被 IME 拦截。

use enigo::{Direction, Enigo, Key, Keyboard, Settings};

#[tauri::command]
pub fn inject_paste() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn inject_type(text: String) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    // 按 \n 切段：段内走 text() 直接键入，段间发一次 Shift+Return 作为软换行——
    // Slack / Discord / Teams / WhatsApp / Telegram / iMessage / 飞书 / 钉钉 等
    // 都把裸 Return 绑成"发送"，Shift+Return 才是不触发发送的换行。
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut first = true;
    for segment in normalized.split('\n') {
        if !first {
            enigo
                .key(Key::Shift, Direction::Press)
                .map_err(|e| e.to_string())?;
            let click = enigo.key(Key::Return, Direction::Click);
            let release = enigo.key(Key::Shift, Direction::Release);
            click.map_err(|e| e.to_string())?;
            release.map_err(|e| e.to_string())?;
        }
        first = false;
        if !segment.is_empty() {
            enigo.text(segment).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
