import { create } from "zustand";
import { db } from "@/lib/db";
import { newId } from "@/lib/ids";

export type DictSource = "manual" | "auto";
export type DictCreatedBy = "manual" | "agent";

export interface DictEntry {
  id: string;
  term: string;
  aliases: string[]; // 空数组表示无别名
  source: DictSource;
  enabled: boolean;
  created_at: number;
  updated_at?: number | null;
  created_by?: DictCreatedBy | null;
}

export interface DictInput {
  term: string;
  aliases?: string[];
  source?: DictSource;
  enabled?: boolean;
  created_by?: DictCreatedBy;
}

export interface DictPatch {
  term?: string;
  aliases?: string[];
  enabled?: boolean;
}

// DB 侧 aliases 用 JSON 文本串存，取出时再 JSON.parse。
// enabled 走 INTEGER 0/1（SQLite 无 bool）。
interface Row {
  id: string;
  term: string;
  aliases: string | null;
  source: DictSource;
  enabled: number;
  created_at: number;
  updated_at: number | null;
  created_by: DictCreatedBy | null;
}

function rowToEntry(r: Row): DictEntry {
  let aliases: string[] = [];
  if (r.aliases) {
    try {
      const parsed = JSON.parse(r.aliases);
      if (Array.isArray(parsed)) aliases = parsed.filter((x) => typeof x === "string");
    } catch {
      // 坏数据容忍：忽略当前行的 aliases，不影响整体加载
      aliases = [];
    }
  }
  return {
    id: r.id,
    term: r.term,
    aliases,
    source: r.source,
    enabled: r.enabled === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
  };
}

interface DictStore {
  entries: DictEntry[];
  loaded: boolean;
  init: () => Promise<void>;
  reload: () => Promise<void>;
  add: (input: DictInput) => Promise<DictEntry>;
  update: (id: string, patch: DictPatch) => Promise<DictEntry>;
  remove: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

// 词典上限 2,000 条（见 docs/dictionary.md "业务约束 2"）。
export const DICT_LIMIT = 2000;

export const useDictionaryStore = create<DictStore>((set, get) => ({
  entries: [],
  loaded: false,

  init: async () => {
    if (get().loaded) return;
    await get().reload();
    set({ loaded: true });
  },

  reload: async () => {
    const d = await db();
    const rows = await d.select<Row[]>(
      "SELECT id, term, aliases, source, enabled, created_at, updated_at, created_by FROM dictionary ORDER BY created_at DESC",
    );
    set({ entries: rows.map(rowToEntry) });
  },

  add: async (input) => {
    const term = input.term.trim().replace(/\s+/g, " ");
    if (!term) throw new Error("term 不能为空");
    if (get().entries.length >= DICT_LIMIT) {
      throw new Error(`词典已达上限 ${DICT_LIMIT} 条`);
    }
    const d = await db();
    const entry: DictEntry = {
      id: newId(),
      term,
      aliases: input.aliases ?? [],
      source: input.source ?? "manual",
      enabled: input.enabled ?? true,
      created_at: Date.now(),
      updated_at: null,
      created_by: input.created_by ?? "manual",
    };
    await d.execute(
      "INSERT INTO dictionary (id, term, aliases, source, enabled, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        entry.id,
        entry.term,
        entry.aliases.length ? JSON.stringify(entry.aliases) : null,
        entry.source,
        entry.enabled ? 1 : 0,
        entry.created_at,
        entry.created_by,
      ],
    );
    set({ entries: [entry, ...get().entries] });
    return entry;
  },

  update: async (id, patch) => {
    const cur = get().entries.find((e) => e.id === id);
    if (!cur) throw new Error(`dictionary entry not found: ${id}`);
    const nextTerm = patch.term !== undefined ? patch.term.trim().replace(/\s+/g, " ") : cur.term;
    if (!nextTerm) throw new Error("term 不能为空");
    const nextAliases = patch.aliases !== undefined ? patch.aliases : cur.aliases;
    const nextEnabled = patch.enabled !== undefined ? patch.enabled : cur.enabled;
    const updated_at = Date.now();
    const d = await db();
    await d.execute(
      "UPDATE dictionary SET term = $1, aliases = $2, enabled = $3, updated_at = $4 WHERE id = $5",
      [
        nextTerm,
        nextAliases.length ? JSON.stringify(nextAliases) : null,
        nextEnabled ? 1 : 0,
        updated_at,
        id,
      ],
    );
    const next: DictEntry = {
      ...cur,
      term: nextTerm,
      aliases: nextAliases,
      enabled: nextEnabled,
      updated_at,
    };
    set({ entries: get().entries.map((e) => (e.id === id ? next : e)) });
    return next;
  },

  remove: async (id) => {
    const d = await db();
    await d.execute("DELETE FROM dictionary WHERE id = $1", [id]);
    set({ entries: get().entries.filter((e) => e.id !== id) });
  },

  clearAll: async () => {
    const d = await db();
    await d.execute("DELETE FROM dictionary");
    set({ entries: [] });
  },
}));
