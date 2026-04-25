// 文本注入：转写结果写入剪贴板后，模拟粘贴键发送到当前焦点输入框。
// 当前仅实现"剪贴板 + 模拟粘贴"路径；逐字符模拟（enigo `text`）作为未来切换项。
// macOS 用 Cmd+V，Windows / Linux 用 Ctrl+V。

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
