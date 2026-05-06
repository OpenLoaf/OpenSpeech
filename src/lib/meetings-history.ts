// 会议历史的数据层（直接走 tauri-plugin-sql）。
//
// 与 `src/stores/history.ts` 故意分离：
//   - 主历史（dictation/ask/translate）由 useHistoryStore 管，UI 在 /history 页
//   - 会议历史是独立的二级界面，由 useMeetingsStore 拉取，schema 复用 history 表
//   - useHistoryStore.reload 已加 `WHERE type != 'meeting'` 把会议过滤掉
//
// 删除一行 history（type='meeting'）时，依赖 SQLite ON DELETE CASCADE 联动
// 删除 history_segments；外键由 lib/db.ts 显式 `PRAGMA foreign_keys = ON`。

import { db } from "@/lib/db";
import { newId } from "@/lib/ids";
import { deleteRecordingFile } from "@/lib/audio";

/** 会议主行（history 表，type='meeting'）。 */
export interface MeetingHistoryRow {
  id: string;
  text: string;
  duration_ms: number;
  created_at: number;
  audio_path: string | null;
  /** 写库时填入的供应商通道，如 "tencent-realtime"。 */
  provider_kind: string | null;
}

/** 会议子片段（history_segments 表）。 */
export interface MeetingSegmentRow {
  id: string;
  history_id: string;
  sentence_id: number;
  speaker_id: number;
  speaker_label: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  created_at: number;
}

/** stop 落库时调用方传入的 segment 子集（仅 final）。 */
export interface InsertSegmentInput {
  sentenceId: number;
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface InsertMeetingInput {
  /** history.id，等于会议 id；UI 渲染回顾视图时用同一个 id 当 key。 */
  meetingId: string;
  text: string;
  durationMs: number;
  audioPath: string | null;
  providerKind: string;
  segments: InsertSegmentInput[];
}

/** 写一条会议主行 + 全部 final 子片段。事务内执行，失败整体回滚。 */
export async function insertMeetingHistory(input: InsertMeetingInput): Promise<void> {
  const d = await db();
  const createdAt = Date.now();
  await d.execute("BEGIN");
  try {
    await d.execute(
      `INSERT INTO history (
        id, type, text, status, duration_ms, created_at,
        audio_path, provider_kind, meeting_id
      ) VALUES ($1, 'meeting', $2, 'success', $3, $4, $5, $6, $7)`,
      [
        input.meetingId,
        input.text,
        input.durationMs,
        createdAt,
        input.audioPath,
        input.providerKind,
        input.meetingId,
      ],
    );
    for (const seg of input.segments) {
      await d.execute(
        `INSERT INTO history_segments (
          id, history_id, sentence_id, speaker_id, speaker_label,
          text, start_ms, end_ms, created_at
        ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)`,
        [
          newId(),
          input.meetingId,
          seg.sentenceId,
          seg.speakerId,
          seg.text,
          seg.startMs,
          seg.endMs,
          createdAt,
        ],
      );
    }
    await d.execute("COMMIT");
  } catch (e) {
    try {
      await d.execute("ROLLBACK");
    } catch {
      /* noop */
    }
    throw e;
  }
}

/** 列出最近会议（按创建时间倒序）。limit 默认 30 条。 */
export async function listRecentMeetings(limit = 30): Promise<MeetingHistoryRow[]> {
  const d = await db();
  return await d.select<MeetingHistoryRow[]>(
    `SELECT id, text, duration_ms, created_at, audio_path, provider_kind
     FROM history WHERE type = 'meeting'
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

/** 拉一场会议的全部子片段（按 sentence_id 升序）。 */
export async function loadMeetingSegments(meetingId: string): Promise<MeetingSegmentRow[]> {
  const d = await db();
  return await d.select<MeetingSegmentRow[]>(
    `SELECT id, history_id, sentence_id, speaker_id, speaker_label,
            text, start_ms, end_ms, created_at
     FROM history_segments WHERE history_id = $1
     ORDER BY sentence_id ASC`,
    [meetingId],
  );
}

/** 删除一场会议（联动删 audio 文件，由 SQLite cascade 删 history_segments）。 */
export async function deleteMeeting(meetingId: string): Promise<void> {
  const d = await db();
  const rows = await d.select<{ audio_path: string | null }[]>(
    "SELECT audio_path FROM history WHERE id = $1 AND type = 'meeting'",
    [meetingId],
  );
  await d.execute("DELETE FROM history WHERE id = $1 AND type = 'meeting'", [meetingId]);
  const audioPath = rows[0]?.audio_path;
  if (audioPath) {
    void deleteRecordingFile(audioPath).catch((e) =>
      console.warn("[meetings] delete audio failed:", audioPath, e),
    );
  }
}
