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
    enigo.text(&text).map_err(|e| e.to_string())?;
    Ok(())
}
