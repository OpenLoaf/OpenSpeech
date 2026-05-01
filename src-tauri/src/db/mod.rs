// OpenSpeech 本地数据库（SQLite，经 tauri-plugin-sql）
//
// 职责：
// 1. 声明 schema 迁移：history（转写记录） / dictionary（自定义词汇）。
// 2. 暴露 `recordings_dir()` —— 每次真实录音（task #13）落盘的 OGG 目录。
//    数据库里 history.audio_path 仅存 **相对路径**：
//    - 新版：`recordings/<yyyy-MM-dd>/<id>.ogg`（按本地日期分子目录）
//    - 迁移前老记录：`recordings/<id>.ogg` 或 `.wav`（继续兼容读取/导出/重转写）
//    跨平台 / 备份还原更友好，运行时拼上 app_data_dir 即可。
//
// DB 文件名：openspeech.db，由 tauri-plugin-sql 默认落在 app_data_dir 下。
// 前端通过 `Database.load("sqlite:openspeech.db")` 使用（见 src/lib/db.ts）。

use std::path::PathBuf;

use tauri::{Manager, Runtime};
use tauri_plugin_sql::{Migration, MigrationKind};

/// 前端 `Database.load(DB_URL)` 的 URL —— 也用于 sql 插件的 capability 权限匹配。
pub const DB_URL: &str = "sqlite:openspeech.db";

/// 所有录音文件所在目录（`app_data_dir/recordings/`）。
/// 调用方不保证此目录已创建——`ensure_recordings_dir` 会 mkdir_p。
#[allow(dead_code)] // 被 task #13 的录音落盘路径用，当前仅 schema 留口
pub fn recordings_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("recordings"))
}

/// 确保 recordings 目录存在；幂等。
#[allow(dead_code)]
pub fn ensure_recordings_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = recordings_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir recordings: {e}"))?;
    Ok(dir)
}

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_history_and_dictionary",
            sql: r#"
CREATE TABLE IF NOT EXISTS history (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL CHECK (type IN ('dictation', 'ask', 'translate')),
    text         TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('success', 'failed', 'cancelled')),
    error        TEXT,
    duration_ms  INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    target_app   TEXT,
    audio_path   TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_type ON history(type);

CREATE TABLE IF NOT EXISTS dictionary (
    id          TEXT PRIMARY KEY,
    term        TEXT NOT NULL,
    aliases     TEXT,
    source      TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at  INTEGER NOT NULL
);

-- term 大小写不敏感唯一，避免 "OpenSpeech" / "openspeech" 重复录入
CREATE UNIQUE INDEX IF NOT EXISTS idx_dictionary_term_ci ON dictionary(LOWER(term));
CREATE INDEX IF NOT EXISTS idx_dictionary_source ON dictionary(source);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "history_add_refined_text",
            sql: r#"
ALTER TABLE history ADD COLUMN refined_text TEXT;
"#,
            kind: MigrationKind::Up,
        },
    ]
}
