// SQLite 前端句柄：通过 tauri-plugin-sql 连接 openspeech.db。
// 该 DB 文件落在 Tauri 的 app_data_dir 下，migration 由 Rust 侧声明（见
// src-tauri/src/db/mod.rs）。前端仅需拿到句柄后做 CRUD。

import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:openspeech.db";

let dbPromise: Promise<Database> | null = null;

export function db(): Promise<Database> {
  if (!dbPromise) {
    // SQLite 默认 foreign_keys=OFF，会议历史依赖
    // history → history_segments 的 ON DELETE CASCADE，必须显式开启。
    dbPromise = Database.load(DB_URL).then(async (d) => {
      try {
        await d.execute("PRAGMA foreign_keys = ON");
      } catch (e) {
        console.warn("[db] enable foreign_keys failed:", e);
      }
      return d;
    });
  }
  return dbPromise;
}
