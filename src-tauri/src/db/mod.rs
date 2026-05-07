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
        Migration {
            version: 3,
            description: "history_add_asr_and_ai_model",
            sql: r#"
ALTER TABLE history ADD COLUMN asr_source TEXT;
ALTER TABLE history ADD COLUMN ai_model TEXT;
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "history_add_segment_mode_and_provider_kind",
            sql: r#"
ALTER TABLE history ADD COLUMN segment_mode TEXT;
ALTER TABLE history ADD COLUMN provider_kind TEXT;
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "history_add_target_lang",
            sql: r#"
ALTER TABLE history ADD COLUMN target_lang TEXT;
"#,
            kind: MigrationKind::Up,
        },
        // v6：会议模式接入。
        // - history.type 之前 CHECK 限 ('dictation','ask','translate')，加 'meeting' 必须重建表
        //   （SQLite 不支持 ALTER TABLE 改 CHECK）。临时表 + INSERT SELECT + RENAME 是标准套路。
        // - 新增 meeting_id 字段：会议子片段（history_segments）通过它回引主 history 行。
        // - 新增 history_segments：每条 final 片段一行；partial 不落库。
        Migration {
            version: 6,
            description: "history_add_meeting_kind_and_segments",
            sql: r#"
CREATE TABLE history_new (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL CHECK (type IN ('dictation', 'ask', 'translate', 'meeting')),
    text         TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('success', 'failed', 'cancelled')),
    error        TEXT,
    duration_ms  INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    target_app   TEXT,
    audio_path   TEXT,
    refined_text TEXT,
    asr_source   TEXT,
    ai_model     TEXT,
    segment_mode TEXT,
    provider_kind TEXT,
    target_lang  TEXT,
    meeting_id   TEXT
);
INSERT INTO history_new (
    id, type, text, status, error, duration_ms, created_at, target_app, audio_path,
    refined_text, asr_source, ai_model, segment_mode, provider_kind, target_lang
)
SELECT
    id, type, text, status, error, duration_ms, created_at, target_app, audio_path,
    refined_text, asr_source, ai_model, segment_mode, provider_kind, target_lang
FROM history;
DROP TABLE history;
ALTER TABLE history_new RENAME TO history;

CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_type ON history(type);
CREATE INDEX IF NOT EXISTS idx_history_meeting_id ON history(meeting_id);

CREATE TABLE IF NOT EXISTS history_segments (
    id            TEXT PRIMARY KEY,
    history_id    TEXT NOT NULL,
    sentence_id   INTEGER NOT NULL,
    speaker_id    INTEGER NOT NULL,
    speaker_label TEXT,
    text          TEXT NOT NULL,
    start_ms      INTEGER NOT NULL,
    end_ms        INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (history_id) REFERENCES history(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_history_segments_history_id ON history_segments(history_id);
CREATE INDEX IF NOT EXISTS idx_history_segments_speaker ON history_segments(history_id, speaker_id);
"#,
            kind: MigrationKind::Up,
        },
        // v7：耗时分段统计。
        // - asr_ms：从 finalize 启动（用户结束录音）到拿到 ASR final transcript 的耗时。
        //   REALTIME 走 stt_finalize 等 server Final；UTTERANCE 走 transcribe_recording_file 文件转写。
        // - refine_ms：AI refine chat stream 从首个 chunk 请求到流式完成的耗时。null = 未启用 refine。
        // 设计取舍：分两个字段而不是合成 total，便于历史详情页区分"是 ASR 慢还是 LLM 慢"。
        Migration {
            version: 7,
            description: "history_add_asr_and_refine_ms",
            sql: r#"
ALTER TABLE history ADD COLUMN asr_ms INTEGER;
ALTER TABLE history ADD COLUMN refine_ms INTEGER;
"#,
            kind: MigrationKind::Up,
        },
        // v8：会议时间轴改用 jsonl 文件存储。
        // - history_segments 是 append-only + 整段读 + 不修改的访问模式，关系表浪费索引/页开销。
        // - 改成与 audio 并列的 `recordings/<yyyy-MM-dd>/<id>.jsonl`，一场会议两个文件。
        // - 旧 meeting 数据直接清掉（产品未发布，无用户数据需保住），cascade 自动清空 segments。
        Migration {
            version: 8,
            description: "meeting_transcript_to_jsonl",
            sql: r#"
DELETE FROM history WHERE type = 'meeting';
ALTER TABLE history ADD COLUMN transcript_path TEXT;
DROP INDEX IF EXISTS idx_history_segments_history_id;
DROP INDEX IF EXISTS idx_history_segments_speaker;
DROP TABLE IF EXISTS history_segments;
"#,
            kind: MigrationKind::Up,
        },
        // v9：会议 AI 纪要落盘到 `recordings/<yyyy-MM-dd>/<id>.summary.md`。
        // history 表只存路径指针，纪要正文走文件——markdown 文本可能很长，
        // 单行膨胀对 SQLite 检索 / VACUUM 都不友好。
        Migration {
            version: 9,
            description: "history_add_summary_path",
            sql: "ALTER TABLE history ADD COLUMN summary_path TEXT;",
            kind: MigrationKind::Up,
        },
        // v10：DEV 模式下落库的请求快照（URL / model / body 的 pretty JSON）。
        // 复制按钮直接读这一列；非 DEV 构建写入路径不会触发，所以正式版用户库里恒为 NULL。
        Migration {
            version: 10,
            description: "history_add_debug_payload",
            sql: "ALTER TABLE history ADD COLUMN debug_payload TEXT;",
            kind: MigrationKind::Up,
        },
        // v11：用户对一条 history 的手动修正落库。
        // - text_edited：用户在历史详情里改完后的最终文本；NULL = 未编辑过。
        // - text_edited_at：编辑时间戳（ms），用于后续异步 AI 词典分析任务挑"近期编辑"。
        // 故意不覆盖 text / refined_text——保留原始 ASR / 原 refine 结果作为 diff 基线。
        Migration {
            version: 11,
            description: "history_add_text_edited",
            sql: r#"
ALTER TABLE history ADD COLUMN text_edited TEXT;
ALTER TABLE history ADD COLUMN text_edited_at INTEGER;
"#,
            kind: MigrationKind::Up,
        },
        // v12：录音瞬间的前台窗口标题。和 target_app 同生命周期采集（getActiveWindowInfo
        // 一次 invoke 拿全），用于在 ConversationHistory 段每条历史后显式拼出标题，
        // 让模型区分"在 main.rs 里聊"和"在 README 里聊"——同 app 不同任务的偏置。
        Migration {
            version: 12,
            description: "history_add_focus_title",
            sql: "ALTER TABLE history ADD COLUMN focus_title TEXT;",
            kind: MigrationKind::Up,
        },
        // v13：dictionary 增加 updated_at（异步 AI agent 改写后的时间戳）和 created_by
        // （'manual' / 'agent'，老行 = NULL 视为 manual）。区分"用户手动添加"与"agent 决策
        // 添加/更新"，便于词典页 UI 标注与未来排序。
        Migration {
            version: 13,
            description: "dictionary_add_updated_at_and_created_by",
            sql: r#"
ALTER TABLE dictionary ADD COLUMN updated_at INTEGER;
ALTER TABLE dictionary ADD COLUMN created_by TEXT;
"#,
            kind: MigrationKind::Up,
        },
    ]
}
