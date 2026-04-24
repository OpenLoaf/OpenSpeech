import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  Copy,
  CornerUpLeft,
  Download,
  Minus,
  MoreHorizontal,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchBox } from "@/components/SearchBox";

// ─────────────────────────────────────────────────────────────
// Types & placeholder data
// ─────────────────────────────────────────────────────────────

type HistoryType = "dictation" | "ask" | "translate";
type HistoryStatus = "success" | "failed" | "cancelled";

interface HistoryItem {
  id: string;
  type: HistoryType;
  text: string;
  status: HistoryStatus;
  error?: string;
  duration_ms: number;
  created_at: string; // ISO string
  target_app?: string;
}

// 基于 2026-04-24 构造的占位数据
const historyItems: HistoryItem[] = [
  {
    id: "h-001",
    type: "dictation",
    text: "继续把这一段的结构调整为先摆结论，再给出证据，然后再讲我们为什么能做得比别人更好。",
    status: "success",
    duration_ms: 8400,
    created_at: "2026-04-24T03:08:12Z",
    target_app: "VSCode",
  },
  {
    id: "h-002",
    type: "ask",
    text: "React 19 和 18 有哪些不兼容改动？重点讲讲 ref 的变化和 use() 这个新 hook。",
    status: "success",
    duration_ms: 5200,
    created_at: "2026-04-24T02:41:55Z",
    target_app: "Chrome",
  },
  {
    id: "h-003",
    type: "dictation",
    text: "回一下这封邮件：David 你好，感谢你发来的方案，整体时间线我觉得可以接受，不过预算这一块希望下周一我们再一起过一遍。",
    status: "success",
    duration_ms: 11800,
    created_at: "2026-04-24T01:12:03Z",
    target_app: "Mail",
  },
  {
    id: "h-004",
    type: "dictation",
    text: "网络超时了，这一段还没来得及注入就断了。",
    status: "failed",
    error: "network timeout",
    duration_ms: 3600,
    created_at: "2026-04-23T22:17:40Z",
  },
  {
    id: "h-005",
    type: "translate",
    text: "把这段翻译成英文：我认为我们应该把核心流程先跑通再谈优化。→ I think we should get the core flow working end-to-end before we talk about optimization.",
    status: "success",
    duration_ms: 6100,
    created_at: "2026-04-23T15:04:22Z",
    target_app: "Notion",
  },
  {
    id: "h-006",
    type: "dictation",
    text: "呃……算了这段不要了。",
    status: "cancelled",
    duration_ms: 1400,
    created_at: "2026-04-23T09:47:18Z",
  },
  {
    id: "h-007",
    type: "ask",
    text: "帮我想一个产品名字，是给程序员用的语音输入工具，英文名，要有工业感，三到四个字母。",
    status: "success",
    duration_ms: 4700,
    created_at: "2026-04-22T18:30:55Z",
    target_app: "Figma",
  },
  {
    id: "h-008",
    type: "translate",
    text: "翻译成中文：The team shipped a quiet but meaningful refactor this week. → 团队这周悄悄做了一次小但很关键的重构。",
    status: "success",
    duration_ms: 5500,
    created_at: "2026-04-21T14:22:11Z",
    target_app: "Slack",
  },
  {
    id: "h-009",
    type: "dictation",
    text: "会议纪要：1. 下周发布内测；2. Anson 负责安装包签名；3. 词典功能延期到 v0.3。",
    status: "success",
    duration_ms: 9200,
    created_at: "2026-04-18T10:05:33Z",
    target_app: "Obsidian",
  },
  {
    id: "h-010",
    type: "ask",
    text: "Tauri 2 里 global shortcut 插件在 macOS 上需要什么权限？",
    status: "failed",
    error: "LLM rate limit",
    duration_ms: 2800,
    created_at: "2026-04-15T21:48:09Z",
  },
  {
    id: "h-011",
    type: "dictation",
    text: "这段是给设计师的反馈：图标再小半号，间距保持不变，视觉重心往左偏一点。",
    status: "success",
    duration_ms: 7300,
    created_at: "2026-04-12T11:19:27Z",
    target_app: "Linear",
  },
];

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

const TODAY = new Date("2026-04-24T00:00:00Z");

function bucketOf(iso: string): Bucket {
  const d = new Date(iso);
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.floor((TODAY.getTime() - d.getTime()) / dayMs);
  if (diff <= 0) return "TODAY";
  if (diff === 1) return "YESTERDAY";
  if (diff <= 7) return "THIS WEEK";
  return "EARLIER";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
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

function TypeChip({ type }: { type: HistoryType }) {
  return (
    <span className="inline-flex items-center border border-te-gray/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
      {typeLabel(type)}
    </span>
  );
}

function RowActions({ status }: { status: HistoryStatus }) {
  const isFailed = status === "failed";
  const baseBtn =
    "inline-flex size-7 items-center justify-center border border-transparent text-te-light-gray transition-colors hover:border-te-gray/60 hover:text-te-accent";

  return (
    <div className="flex items-center gap-1">
      {/* 失败态：重试按钮常显，带文字，方形灰底 */}
      {isFailed && (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 border border-te-gray/40 bg-te-surface px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          title="重试转录"
        >
          <RotateCcw className="size-3" strokeWidth={2} />
          <span>重试</span>
        </button>
      )}

      {/* 其他图标按钮：hover 才显现 */}
      <div className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <button type="button" className={baseBtn} title="复制">
          <Copy className="size-3.5" />
        </button>
        <button type="button" className={baseBtn} title="重新注入">
          <CornerUpLeft className="size-3.5" />
        </button>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center border border-transparent text-te-light-gray transition-colors hover:border-[#ff4d4d]/60 hover:text-[#ff4d4d]"
          title="删除"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
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

      {/* 状态 + 操作 */}
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <RowActions status={item.status} />
        {!isFailed && <StatusBadge status={item.status} />}
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
  const [items, setItems] = useState<HistoryItem[]>(historyItems);
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

  const clearAll = () => {
    setItems([]);
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
    // 每组内按时间倒序
    for (const k of BUCKET_ORDER) {
      map[k].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
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
