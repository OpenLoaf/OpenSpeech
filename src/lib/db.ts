// SQLite 前端句柄：通过 tauri-plugin-sql 连接 openspeech.db。
// 该 DB 文件落在 Tauri 的 app_data_dir 下，migration 由 Rust 侧声明（见
// src-tauri/src/db/mod.rs）。前端仅需拿到句柄后做 CRUD。

import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:openspeech.db";

let dbPromise: Promise<Database> | null = null;

export function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load(DB_URL);
  return dbPromise;
}
