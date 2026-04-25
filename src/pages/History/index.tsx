import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  Minus,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchBox } from "@/components/SearchBox";
import {
  useHistoryStore,
  type HistoryItem,
  type HistoryStatus,
  type HistoryType,
} from "@/stores/history";
import { usePlaybackStore } from "@/stores/playback";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const RETENTION_OPTIONS = [
  { value: "forever", label: "永远" },
  { value: "90d", label: "90 天" },
  { value: "30d", label: "30 天" },
  { value: "7d", label: "7 天" },
  { value: "off", label: "不保存" },
] as const;

type RetentionValue = (typeof RETENTION_OPTIONS)[number]["value"];

const FILTER_TABS = [
  { value: "all", label: "全部" },
  { value: "dictation", label: "听写" },
  { value: "ask", label: "随便问" },
  { value: "translate", label: "翻译" },
] as const;

type FilterValue = (typeof FILTER_TABS)[number]["value"];

// 相对今天（2026-04-24）的分组
type Bucket = "TODAY" | "YESTERDAY" | "THIS WEEK" | "EARLIER";
const BUCKET_ORDER: Bucket[] = ["TODAY", "YESTERDAY", "THIS WEEK", "EARLIER"];
const BUCKET_LABEL: Record<Bucket, string> = {
  TODAY: "今天",
  YESTERDAY: "昨天",
  "THIS WEEK": "本周",
  EARLIER: "更早",
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// 相对"今天 00:00（本地时区）"分桶；比直接用 Date.now 更稳——例如凌晨 00:05 的
// 记录应该算"今天"而不是"不到 24 小时前"。
function todayMidnightLocal(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketOf(ts: number): Bucket {
  const diffDays = Math.floor((todayMidnightLocal() - ts) / DAY_MS);
  if (diffDays < 1) return "TODAY";
  if (diffDays < 2) return "YESTERDAY";
  if (diffDays < 7) return "THIS WEEK";
  return "EARLIER";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function typeLabel(t: HistoryType): string {
  return t === "dictation" ? "听写" : t === "ask" ? "随便问" : "翻译";
}

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

function RetentionBar({
  value,
  onChange,
}: {
  value: RetentionValue;
  onChange: (v: RetentionValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = RETENTION_OPTIONS.find((o) => o.value === value)!;

  return (
    <motion.div
      data-tauri-drag-region="false"
      className="relative z-20 mt-4 flex flex-col gap-4 border border-te-gray/40 bg-te-surface p-6 md:flex-row md:items-center md:justify-between"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div>
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-te-accent">
          RETENTION POLICY
        </div>
        <div className="mt-2 text-sm text-te-light-gray">
          历史保留时长 — 控制本机数据库中的记录留存时间。
        </div>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group inline-flex items-center gap-2 border border-te-gray/60 bg-te-bg px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <span>{current.label}</span>
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="inline-flex"
          >
            <ChevronDown className="size-3.5" />
          </motion.span>
        </button>

        <AnimatePresence>
          {open && (
            <motion.ul
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 z-10 mt-2 min-w-[14rem] border border-te-gray/60 bg-te-bg py-1 shadow-none"
            >
              {RETENTION_OPTIONS.map((opt) => {
                const active = opt.value === value;
                return (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
                        active
                          ? "bg-te-surface-hover text-te-accent"
                          : "text-te-fg hover:bg-te-surface-hover hover:text-te-accent"
                      }`}
                    >
                      <span>{opt.label}</span>
                      {active && <Check className="size-3.5" />}
                    </button>
                  </li>
                );
              })}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function FilterTabs({
  value,
  onChange,
}: {
  value: FilterValue;
  onChange: (v: FilterValue) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {FILTER_TABS.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            className={`relative px-4 py-3 font-mono text-xs uppercase tracking-wider transition-colors ${
              active
                ? "bg-te-surface-hover text-te-accent"
                : "text-te-light-gray hover:text-te-fg"
            }`}
          >
            {tab.label}
            {active && (
              <motion.span
                layoutId="history-tab-underline"
                className="absolute bottom-0 left-0 h-[2px] w-full bg-te-accent"
                transition={{ duration: 0.25 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: HistoryStatus }) {
  if (status === "success") {
    return (
      <span
        className="inline-flex size-5 items-center justify-center font-mono text-xs text-te-accent"
        title="成功"
      >
        <Check className="size-3.5" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        className="inline-flex size-5 items-center justify-center font-mono text-xs text-[#ff4d4d]"
        title="失败"
      >
        <X className="size-3.5" strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex size-5 items-center justify-center font-mono text-xs text-te-light-gray"
      title="已取消"
    >
      <Minus className="size-3.5" strokeWidth={2.5} />
    </span>
  );
}

// 有录音文件的成功 / 取消记录展示此按钮：点击 = 播放原始 WAV；再次点击 = 暂停。
// 切到别的行时，此行自动从 Pause 图标回落到 Play。
function PlayButton({ id, audioPath }: { id: string; audioPath: string }) {
  const playingId = usePlaybackStore((s) => s.playingId);
  const toggle = usePlaybackStore((s) => s.toggle);
  const isPlaying = playingId === id;

  return (
    <button
      type="button"
      onClick={() => {
        void toggle(id, audioPath);
      }}
      className={`inline-flex size-7 items-center justify-center border transition-colors ${
        isPlaying
          ? "border-te-accent bg-te-accent text-te-bg"
          : "border-te-gray/40 text-te-accent hover:border-te-accent hover:bg-te-accent hover:text-te-bg"
      }`}
      title={isPlaying ? "暂停" : "播放原始录音"}
    >
      {isPlaying ? (
        <Pause className="size-3.5" strokeWidth={2.5} />
      ) : (
        <Play className="size-3.5" strokeWidth={2.5} fill="currentColor" />
      )}
    </button>
  );
}

function TypeChip({ type }: { type: HistoryType }) {
  return (
    <span className="inline-flex items-center border border-te-gray/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
      {typeLabel(type)}
    </span>
  );
}

function RowActions({
  status,
  text,
}: {
  status: HistoryStatus;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const isFailed = status === "failed";
  const baseBtn =
    "inline-flex size-7 items-center justify-center border border-transparent text-te-light-gray transition-colors hover:border-te-gray/60 hover:text-te-accent";
  const dangerBtn =
    "inline-flex size-7 items-center justify-center border border-transparent text-te-light-gray transition-colors hover:border-[#ff4d4d]/60 hover:text-[#ff4d4d]";

  const handleCopy = async () => {
    if (!text) return;
    try {
      await writeText(text);
      setCopied(true);
      toast.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error("[history] copy failed:", e);
      toast.error("复制失败");
    }
  };

  // 失败态：只有「(hover) 删除 + 重试常显」，由外层 HistoryRow 在更右侧再放一个播放按钮。
  if (isFailed) {
    return (
      <div className="flex items-center gap-1">
        <div className="pointer-events-none flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <button type="button" className={dangerBtn} title="删除">
            <Trash2 className="size-3.5" />
          </button>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 border border-te-gray/40 bg-te-surface px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          title="重试转录"
        >
          <RotateCcw className="size-3" strokeWidth={2} />
          <span>重试</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
      <button
        type="button"
        className={baseBtn}
        title={copied ? "已复制" : "复制到剪贴板"}
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="size-3.5" strokeWidth={2.5} />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
      <button type="button" className={baseBtn} title="重新注入">
        <RotateCcw className="size-3.5" />
      </button>
      <button type="button" className={dangerBtn} title="删除">
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

function HistoryRow({ item, index }: { item: HistoryItem; index: number }) {
  const isFailed = item.status === "failed";
  const displayText = isFailed
    ? "您的转录被中断。但 OpenSpeech 仍可以为您重试。"
    : item.text;

  return (
    <motion.div
      className={`group flex items-start gap-4 border-b border-te-gray/20 px-3 py-4 transition-colors ${
        isFailed
          ? "bg-[#ff4d4d]/10 hover:bg-[#ff4d4d]/15"
          : "hover:bg-te-surface-hover"
      }`}
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.03, 0.3) }}
    >
      {/* 时间列 */}
      <div className="flex w-[72px] shrink-0 flex-col items-start gap-1.5 pt-0.5">
        <span
          className={`font-mono text-xs ${
            isFailed ? "text-[#ff4d4d]/80" : "text-te-light-gray"
          }`}
        >
          {formatTime(item.created_at)}
        </span>
        <TypeChip type={item.type} />
      </div>

      {/* 中间文本 */}
      <div className="min-w-0 flex-1">
        <p
          className={`font-sans text-sm leading-relaxed ${
            isFailed ? "text-[#ff4d4d]" : "text-te-fg"
          }`}
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {displayText}
        </p>
        {!isFailed && item.target_app && (
          <div className="mt-1.5 flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
            <span>
              <span className="text-te-light-gray/60">→</span> {item.target_app}
            </span>
          </div>
        )}
        {isFailed && item.error && (
          <div className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-[#ff4d4d]/70">
            ERR: {item.error}
          </div>
        )}
      </div>

      {/* 状态 + 操作（从右到左：播放、重试 / 操作组、(hover) 删除） */}
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <RowActions status={item.status} text={item.text} />
        {item.audio_path ? (
          <PlayButton id={item.id} audioPath={item.audio_path} />
        ) : !isFailed ? (
          <StatusBadge status={item.status} />
        ) : null}
      </div>
    </motion.div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="mt-10 mb-3 flex items-center gap-3">
      <span className="font-mono text-xs uppercase tracking-widest text-te-light-gray">
        {label}
      </span>
      <span className="h-px flex-1 bg-te-gray/30" />
    </div>
  );
}

function EmptyState() {
  return (
    <motion.div
      className="flex flex-col items-center justify-center py-24"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <span className="font-mono text-sm uppercase tracking-widest text-te-light-gray">
        // 暂无记录 //
      </span>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const items = useHistoryStore((s) => s.items);
  const clearAllInDb = useHistoryStore((s) => s.clearAll);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [retention, setRetention] = useState<RetentionValue>("forever");
  const [query, setQuery] = useState("");
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const filtered = useMemo(() => {
    const base = filter === "all" ? items : items.filter((it) => it.type === filter);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((it) => {
      if (it.text.toLowerCase().includes(q)) return true;
      if (it.target_app?.toLowerCase().includes(q)) return true;
      if (it.error?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [items, filter, query]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(items, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openspeech-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const clearAll = async () => {
    usePlaybackStore.getState().stop();
    await clearAllInDb();
    setConfirmClearOpen(false);
  };

  const grouped = useMemo(() => {
    const map: Record<Bucket, HistoryItem[]> = {
      TODAY: [],
      YESTERDAY: [],
      "THIS WEEK": [],
      EARLIER: [],
    };
    for (const it of filtered) {
      map[bucketOf(it.created_at)].push(it);
    }
    // 每组内按时间倒序（id 是日期增量，直接字典序倒排即时间倒序）
    for (const k of BUCKET_ORDER) {
      map[k].sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
    }
    return map;
  }, [filtered]);

  return (
    <section className="flex h-full flex-col bg-te-bg">
      {/* 顶部固定：标题 + 操作按钮（可拖窗，按钮豁免） */}
      <div data-tauri-drag-region className="shrink-0 bg-te-bg">
        <div
          data-tauri-drag-region
          className="mx-auto max-w-5xl px-[4vw] pt-[clamp(1rem,2vw,2rem)] pb-4"
        >
          <motion.div
            data-tauri-drag-region
            className="flex items-start justify-between gap-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <div data-tauri-drag-region>
              <h1 className="font-mono text-3xl font-bold tracking-tighter text-te-fg">
                历史记录
              </h1>
              <p className="mt-2 text-xs leading-relaxed text-te-light-gray">
                你的数据仅存于本地 — 录音不会上传，历史记录只保留在本设备。
              </p>
            </div>
            <MoreMenu
              onClear={() => setConfirmClearOpen(true)}
              onExport={exportJson}
              disabled={items.length === 0}
            />
          </motion.div>

          <RetentionBar value={retention} onChange={setRetention} />
        </div>
      </div>

      {/* 中部固定：筛选 Tabs + 搜索 */}
      <div data-tauri-drag-region className="shrink-0 bg-te-bg">
        <div data-tauri-drag-region className="mx-auto max-w-5xl px-[4vw]">
          <div className="flex items-center justify-between gap-4 border-b border-te-gray/40">
            <FilterTabs value={filter} onChange={setFilter} />
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="搜索历史..."
            />
          </div>
        </div>
      </div>

      {/* 滚动区：历史列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-[4vw] pb-[clamp(2rem,5vw,5rem)]">
          {filtered.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="mt-2">
              {BUCKET_ORDER.map((bucket) => {
                const rows = grouped[bucket];
                if (rows.length === 0) return null;
                return (
                  <div key={bucket}>
                    <GroupHeader label={BUCKET_LABEL[bucket]} />
                    <div>
                      {rows.map((item, i) => (
                        <HistoryRow key={item.id} item={item} index={i} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmClearDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        count={items.length}
        onConfirm={clearAll}
      />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// More Menu
// ─────────────────────────────────────────────────────────────

function MoreMenu({
  onClear,
  onExport,
  disabled,
}: {
  onClear: () => void;
  onExport: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref} data-tauri-drag-region="false">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-9 items-center justify-center border border-te-gray/40 text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
        title="更多"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="size-4" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 z-20 mt-2 min-w-[12rem] border border-te-gray/60 bg-te-bg py-1"
          >
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onExport();
                }}
                disabled={disabled}
                className="flex w-full items-center gap-2 px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] text-te-fg transition-colors hover:bg-te-surface-hover hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-te-fg"
              >
                <Download className="size-3.5" />
                <span>导出</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onClear();
                }}
                disabled={disabled}
                className="flex w-full items-center gap-2 px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] text-[#ff4d4d] transition-colors hover:bg-[#ff4d4d]/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Trash2 className="size-3.5" />
                <span>删除全部历史</span>
              </button>
            </li>
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Confirm Clear Dialog
// ─────────────────────────────────────────────────────────────

function ConfirmClearDialog({
  open,
  onOpenChange,
  count,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  count: number;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!gap-0 rounded-none border border-te-gray bg-te-bg p-0 sm:max-w-md">
        <DialogHeader className="border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <DialogTitle className="font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
            删除全部历史
          </DialogTitle>
          <DialogDescription className="sr-only">
            清空本机历史记录
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-5 text-sm leading-relaxed text-te-fg">
          将删除本机的{" "}
          <span className="font-mono text-te-accent">{count}</span>{" "}
          条历史记录，操作不可撤销。
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            // 建议先导出备份
          </p>
        </div>

        <DialogFooter className="flex flex-row justify-end gap-2 border-t border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="border border-te-gray/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-[#ff4d4d] px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-white transition-[filter] hover:brightness-110"
          >
            确认删除
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
