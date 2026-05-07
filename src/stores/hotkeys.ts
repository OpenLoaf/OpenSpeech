import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import {
  BINDING_IDS,
  getDefaultBindings,
  type BindingId,
  type BindingKind,
  type HotkeyBinding,
  type HotkeyMod,
  type ModSides,
  type Side,
} from "@/lib/hotkey";
import { detectPlatform } from "@/lib/platform";

const STORE_FILE = "hotkeys.json";
// v2：在 HotkeyBinding 上新增 `kind` 字段（combo / modifierOnly / doubleTap）。
// v1 的数据在 migrate() 里按 `code === "" ? modifierOnly : combo` 推断补齐。
// v3：HotkeyBinding 新增 `modSides`（区分左右）。v2/v1 旧数据 migrate 时为每个
// 非 fn 修饰键填 "left"，对齐"旧绑定一律视为左"的产品决策。
const SCHEMA_VERSION = 3;

interface UndoRecord {
  replacedId: BindingId;
  oldValue: HotkeyBinding | null;
  changedId: BindingId;
  newValue: HotkeyBinding | null;
  expiresAt: number;
}

interface PersistShape {
  schemaVersion: number;
  bindings: Record<BindingId, HotkeyBinding | null>;
  distinguishLeftRight: boolean;
  allowSpecialKeys: boolean;
  undoBuffer: UndoRecord | null;
}

interface HotkeysState {
  bindings: Record<BindingId, HotkeyBinding | null>;
  allowSpecialKeys: boolean;
  loaded: boolean;
  undo: UndoRecord | null;
  init: () => Promise<void>;
  setBinding: (id: BindingId, value: HotkeyBinding | null) => Promise<void>;
  resetBinding: (id: BindingId) => Promise<void>;
  resetAll: () => Promise<void>;
  recordUndo: (record: UndoRecord) => Promise<void>;
  applyUndo: () => Promise<void>;
  clearUndo: () => Promise<void>;
}

let storePromise: Promise<Store> | null = null;

function store(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

function freshDefaults(): Record<BindingId, HotkeyBinding | null> {
  return getDefaultBindings(detectPlatform());
}

// 接受 unknown，返回归一化的 HotkeyBinding 或 null：v1 老数据没有 kind，按
// code 是否为空推断（空 → modifierOnly，非空 → combo）。
// v2/v3 迁移：旧字段 `mode: "hold" | "toggle"` 一律丢弃——系统统一为 toggle。
// v2 → v3：mods 内每个非 fn 修饰键自动补 modSides="left"，落实"旧绑定 = 左"。
function normalizeBinding(raw: unknown): HotkeyBinding | null {
  if (raw == null || typeof raw !== "object") return null;
  const b = raw as Partial<HotkeyBinding> & {
    kind?: BindingKind;
    mode?: unknown;
    modSides?: unknown;
  };
  if (!Array.isArray(b.mods)) return null;
  if (typeof b.code !== "string") return null;
  const kind: BindingKind =
    b.kind ?? (b.code === "" ? "modifierOnly" : "combo");
  const mods = b.mods as HotkeyMod[];
  const modSides: ModSides = {};
  const rawSides =
    b.modSides && typeof b.modSides === "object"
      ? (b.modSides as Record<string, unknown>)
      : {};
  for (const m of mods) {
    if (m === "fn") continue;
    const v = rawSides[m];
    modSides[m as Exclude<HotkeyMod, "fn">] =
      v === "left" || v === "right" ? (v as Side) : "left";
  }
  return { kind, mods, code: b.code, modSides };
}

// 只保留 BINDING_IDS 内的 key，把老版本里残留的（例如被移除的 dictate_toggle）
// 过滤掉；缺失的 key 用平台默认兜底。
function sanitizeBindings(
  raw: unknown,
): Record<BindingId, HotkeyBinding | null> {
  const out = freshDefaults();
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const id of BINDING_IDS) {
      if (id in r) out[id] = normalizeBinding(r[id]);
    }
  }
  return out;
}

async function readPersisted(): Promise<PersistShape> {
  const s = await store();
  const raw = await s.get<unknown>("root");
  const defaults: PersistShape = {
    schemaVersion: SCHEMA_VERSION,
    bindings: freshDefaults(),
    distinguishLeftRight: true,
    allowSpecialKeys: false,
    undoBuffer: null,
  };
  if (!raw || typeof raw !== "object") return defaults;
  const r = raw as Partial<PersistShape> & { schemaVersion?: number };
  if (r.schemaVersion !== SCHEMA_VERSION) {
    return migrate(r, defaults);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    bindings: sanitizeBindings(r.bindings),
    distinguishLeftRight: r.distinguishLeftRight ?? true,
    allowSpecialKeys: r.allowSpecialKeys ?? false,
    undoBuffer: r.undoBuffer ?? null,
  };
}

// v1 → v2：`bindings` 中每项若缺 `kind`，由 `normalizeBinding` 自动推断。
// v2 → v3：每项 mods 中非 fn 修饰键自动补 modSides="left"——由 normalizeBinding
// 统一处理，所以 v1/v2 在这里同一条路径走完即升到 v3。
function migrate(
  old: Partial<PersistShape> & { schemaVersion?: number },
  defaults: PersistShape,
): PersistShape {
  if (old.schemaVersion === 1 || old.schemaVersion === 2) {
    return {
      schemaVersion: SCHEMA_VERSION,
      bindings: sanitizeBindings(old.bindings),
      distinguishLeftRight: true,
      allowSpecialKeys: old.allowSpecialKeys ?? false,
      undoBuffer: old.undoBuffer ?? null,
    };
  }
  return defaults;
}

async function writePersisted(shape: PersistShape): Promise<void> {
  const s = await store();
  await s.set("root", shape);
  await s.save();
}

export const useHotkeysStore = create<HotkeysState>((set, get) => ({
  bindings: freshDefaults(),
  allowSpecialKeys: false,
  loaded: false,
  undo: null,

  init: async () => {
    const p = await readPersisted();
    const undo =
      p.undoBuffer && p.undoBuffer.expiresAt > Date.now() ? p.undoBuffer : null;
    set({
      bindings: p.bindings,
      allowSpecialKeys: p.allowSpecialKeys,
      loaded: true,
      undo,
    });
  },

  setBinding: async (id, value) => {
    const next = { ...get().bindings, [id]: value };
    set({ bindings: next });
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      bindings: next,
      distinguishLeftRight: true,
      allowSpecialKeys: get().allowSpecialKeys,
      undoBuffer: get().undo,
    });
  },

  resetBinding: async (id) => {
    await get().setBinding(id, freshDefaults()[id]);
  },

  resetAll: async () => {
    const defaults = freshDefaults();
    set({ bindings: defaults, undo: null });
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      bindings: defaults,
      distinguishLeftRight: true,
      allowSpecialKeys: get().allowSpecialKeys,
      undoBuffer: null,
    });
  },

  recordUndo: async (record) => {
    set({ undo: record });
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      bindings: get().bindings,
      distinguishLeftRight: true,
      allowSpecialKeys: get().allowSpecialKeys,
      undoBuffer: record,
    });
  },

  applyUndo: async () => {
    const u = get().undo;
    if (!u || u.expiresAt < Date.now()) {
      set({ undo: null });
      return;
    }
    // 实际撤销语义：把"被替换的项"恢复为替换前值；"变更项"保持现状，用户自行处理。
    const restored: Record<BindingId, HotkeyBinding | null> = {
      ...get().bindings,
    };
    restored[u.replacedId] = u.oldValue;
    set({ bindings: restored, undo: null });
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      bindings: restored,
      distinguishLeftRight: true,
      allowSpecialKeys: get().allowSpecialKeys,
      undoBuffer: null,
    });
  },

  clearUndo: async () => {
    set({ undo: null });
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      bindings: get().bindings,
      distinguishLeftRight: true,
      allowSpecialKeys: get().allowSpecialKeys,
      undoBuffer: null,
    });
  },
}));

export type { UndoRecord };
