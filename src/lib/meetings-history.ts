// 会议历史的数据层。
//
// 存储方案（v8 起）：
//   - history 表 type='meeting' 一行存元数据 + transcript_path
//   - 时间轴 segments 落到 `recordings/<yyyy-MM-dd>/<id>.jsonl`，一行一段
//   - 跟音频文件并列：一场会议 = `<id>.ogg` + `<id>.jsonl`，删除时一并清掉
//
// 与 `src/stores/history.ts` 故意分离：
//   - 主历史（dictation/ask/translate）由 useHistoryStore 管，UI 在 /history 页
//   - 会议历史是独立的二级界面，由 useMeetingsStore 拉取，schema 复用 history 表
//   - useHistoryStore.reload 已加 `WHERE type != 'meeting'` 把会议过滤掉

import { invoke } from "@tauri-apps/api/core";

import { db } from "@/lib/db";
import { localDateYmd, deleteRecordingFile } from "@/lib/audio";

/** 会议主行（history 表，type='meeting'）。 */
export interface MeetingHistoryRow {
  id: string;
  text: string;
  duration_ms: number;
  created_at: number;
  audio_path: string | null;
  transcript_path: string | null;
  /** AI 纪要落盘路径（v9 起）。null = 还没生成或生成失败 */
  summary_path: string | null;
  /** 写库时填入的供应商通道，如 "tencent-realtime"。 */
  provider_kind: string | null;
}

/** jsonl 文件里每行的 segment 结构。 */
export interface MeetingSegmentJson {
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
  segments: MeetingSegmentJson[];
}

/** 写一条会议主行 + 把 segments 落到 jsonl。
 *  顺序：先写文件（失败就别污染 db），再 INSERT history（包含 transcript_path）。 */
export async function insertMeetingHistory(input: InsertMeetingInput): Promise<void> {
  const transcriptPath = await writeTranscriptFile(input.meetingId, input.segments);
  const d = await db();
  const createdAt = Date.now();
  try {
    await d.execute(
      `INSERT INTO history (
        id, type, text, status, duration_ms, created_at,
        audio_path, transcript_path, provider_kind, meeting_id
      ) VALUES ($1, 'meeting', $2, 'success', $3, $4, $5, $6, $7, $8)`,
      [
        input.meetingId,
        input.text,
        input.durationMs,
        createdAt,
        input.audioPath,
        transcriptPath,
        input.providerKind,
        input.meetingId,
      ],
    );
  } catch (e) {
    // db 写失败时把孤儿 jsonl 清掉，避免下次扫描看到垃圾文件
    void invoke("meeting_transcript_delete", { transcriptPath }).catch(() => undefined);
    throw e;
  }
}

async function writeTranscriptFile(
  meetingId: string,
  segments: MeetingSegmentJson[],
): Promise<string> {
  const payload = segments.map((s) => JSON.stringify(s)).join("\n") + (segments.length ? "\n" : "");
  return await invoke<string>("meeting_transcript_write", {
    meetingId,
    date: localDateYmd(),
    payload,
  });
}

/** 列出最近会议（按创建时间倒序）。limit 默认 30 条。 */
export async function listRecentMeetings(limit = 30): Promise<MeetingHistoryRow[]> {
  const d = await db();
  return await d.select<MeetingHistoryRow[]>(
    `SELECT id, text, duration_ms, created_at, audio_path, transcript_path, summary_path, provider_kind
     FROM history WHERE type = 'meeting'
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

/** 写一条会议的 AI 纪要 markdown 到磁盘 + 把 summary_path 回写到 history。
 *  幂等：调用方已确保 meetingId 是 history 表里现存的会议行。 */
export async function persistMeetingSummary(meetingId: string, content: string): Promise<string> {
  const summaryPath = await invoke<string>("meeting_summary_write", {
    meetingId,
    date: localDateYmd(),
    content,
  });
  const d = await db();
  await d.execute(
    "UPDATE history SET summary_path = $1 WHERE id = $2 AND type = 'meeting'",
    [summaryPath, meetingId],
  );
  return summaryPath;
}

/** 读一条会议的 AI 纪要 markdown 原文。文件不存在或路径为空时返回空字符串。 */
export async function loadMeetingSummary(summaryPath: string | null): Promise<string> {
  if (!summaryPath) return "";
  return await invoke<string>("meeting_summary_load", { summaryPath });
}

/** 拉一场会议的全部子片段。读 jsonl 文件，按 sentenceId 升序返回。 */
export async function loadMeetingSegments(transcriptPath: string): Promise<MeetingSegmentJson[]> {
  const raw = await invoke<string>("meeting_transcript_load", { transcriptPath });
  const out: MeetingSegmentJson[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as MeetingSegmentJson);
    } catch (e) {
      console.warn("[meetings] skip malformed transcript line:", trimmed, e);
    }
  }
  out.sort((a, b) => a.sentenceId - b.sentenceId);
  return out;
}

function formatHmsLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function speakerName(speakerId: number, speakerLabel: string, pendingLabel: string): string {
  if (speakerId < 0) return pendingLabel;
  const letter = String.fromCharCode(65 + (Math.abs(speakerId) % 26));
  return speakerLabel.replace("{{letter}}", letter);
}

export interface ExportMarkdownInput {
  meeting: MeetingHistoryRow;
  segments: MeetingSegmentJson[];
  /** i18n 文案：标题 / 元数据 label / speaker 模板，由调用方在 React 树里 t() 后传入。 */
  i18n: {
    title: string;
    metaCreated: string;
    metaDuration: string;
    metaSpeakers: string;
    metaSegments: string;
    speakerLabel: string;
    speakerPending: string;
  };
}

export function buildMeetingMarkdown(input: ExportMarkdownInput): string {
  const { meeting, segments, i18n } = input;
  const created = new Date(meeting.created_at);
  const speakerSet = new Set<number>();
  for (const s of segments) {
    if (s.speakerId >= 0) speakerSet.add(s.speakerId);
  }
  const lines: string[] = [];
  lines.push(`# ${i18n.title}`, "");
  lines.push(`- ${i18n.metaCreated}: ${created.toLocaleString()}`);
  lines.push(`- ${i18n.metaDuration}: ${formatHmsLabel(meeting.duration_ms)}`);
  lines.push(`- ${i18n.metaSpeakers}: ${speakerSet.size}`);
  lines.push(`- ${i18n.metaSegments}: ${segments.length}`);
  lines.push("", "---", "");

  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  for (const seg of sorted) {
    const name = speakerName(seg.speakerId, i18n.speakerLabel, i18n.speakerPending);
    lines.push(`**${name}**  ·  ${formatHmsLabel(seg.startMs)}`, "", seg.text.trim(), "");
  }
  return lines.join("\n");
}

/** 把拼好的 Markdown 写到用户选的绝对路径（来自 plugin-dialog::save()）。 */
export async function exportMeetingMarkdown(content: string, destPath: string): Promise<void> {
  await invoke("meeting_export_markdown", { content, destPath });
}

/** 删除一场会议（联动删 audio + transcript + summary 文件）。 */
export async function deleteMeeting(meetingId: string): Promise<void> {
  const d = await db();
  const rows = await d.select<
    {
      audio_path: string | null;
      transcript_path: string | null;
      summary_path: string | null;
    }[]
  >(
    "SELECT audio_path, transcript_path, summary_path FROM history WHERE id = $1 AND type = 'meeting'",
    [meetingId],
  );
  await d.execute("DELETE FROM history WHERE id = $1 AND type = 'meeting'", [meetingId]);
  const audioPath = rows[0]?.audio_path;
  if (audioPath) {
    void deleteRecordingFile(audioPath).catch((e) =>
      console.warn("[meetings] delete audio failed:", audioPath, e),
    );
  }
  const transcriptPath = rows[0]?.transcript_path;
  if (transcriptPath) {
    void invoke("meeting_transcript_delete", { transcriptPath }).catch((e) =>
      console.warn("[meetings] delete transcript failed:", transcriptPath, e),
    );
  }
  const summaryPath = rows[0]?.summary_path;
  if (summaryPath) {
    void invoke("meeting_summary_delete", { summaryPath }).catch((e) =>
      console.warn("[meetings] delete summary failed:", summaryPath, e),
    );
  }
}
