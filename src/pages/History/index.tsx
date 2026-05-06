import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  FlaskConical,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { exportRecordingTo } from "@/lib/audio";
import { AudioWavePlayer } from "@/components/AudioWavePlayer";
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
  NotAuthenticatedError,
  type HistoryItem,
  type HistoryStatus,
  type HistoryType,
} from "@/stores/history";
import { usePlaybackStore } from "@/stores/playback";
import { useRecordingStore } from "@/stores/recording";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import type { HistoryRetention } from "@/stores/settings";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const FILTER_VALUES = ["all", "dictation", "ask", "translate"] as const;
type FilterValue = (typeof FILTER_VALUES)[number];

// 列表渲染分页大小。仅影响 DOM 节点数；items 全量在 store 内存里。
const PAGE_SIZE = 50;

type Bucket = "TODAY" | "YESTERDAY" | "THIS WEEK" | "EARLIER";
const BUCKET_ORDER: Bucket[] = ["TODAY", "YESTERDAY", "THIS WEEK", "EARLIER"];
const BUCKET_I18N_KEY: Record<Bucket, string> = {
  TODAY: "today",
  YESTERDAY: "yesterday",
  "THIS WEEK": "this_week",
  EARLIER: "earlier",
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

function formatFullDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 短时长用 0.8s / 12s，>=1min 用 m:ss，避免 0:03 这种看起来像分钟数的歧义。
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function typeLabel(t: TFunction, type: HistoryType): string {
  return t(`pages:history.filters.${type}`);
}

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

function FilterTabs({
  value,
  onChange,
}: {
  value: FilterValue;
  onChange: (v: FilterValue) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      {FILTER_VALUES.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onChange(tab)}
            className={`relative px-4 py-3 font-mono text-xs uppercase tracking-wider transition-colors ${
              active
                ? "bg-te-surface-hover text-te-accent"
                : "text-te-light-gray hover:text-te-fg"
            }`}
          >
            {t(`pages:history.filters.${tab}`)}
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

function RetentionSelect() {
  const { t } = useTranslation();
  const retention = useSettingsStore((s) => s.general.historyRetention);
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const options: HistoryRetention[] = ["forever", "90d", "30d", "7d", "off"];
  return (
    <label
      className="inline-flex items-center gap-2"
      title={t("pages:history.retention.title")}
    >
      <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
        {t("pages:history.retention.label")}
      </span>
      <div className="relative inline-flex items-center border border-te-gray/40 bg-te-surface transition-colors focus-within:border-te-accent hover:border-te-gray">
        <select
          value={retention}
          onChange={(e) =>
            void setGeneral(
              "historyRetention",
              e.target.value as HistoryRetention,
            )
          }
          className="cursor-pointer appearance-none bg-transparent py-1.5 pr-7 pl-2 font-mono text-xs text-te-fg focus:outline-none"
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {t(`pages:history.retention.options.${o}`)}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 size-3 text-te-light-gray" />
      </div>
    </label>
  );
}


function TypeChip({ type }: { type: HistoryType }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center border border-te-gray/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
      {typeLabel(t, type)}
    </span>
  );
}

type MenuItemSpec = {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  onSelect: () => void;
};

// 行级菜单（"..." 按钮 + 右键共用）。fixed + portal 避免被 history 滚动容器裁掉。
// 视口边界做夹紧，超出右/下时反向贴边。
function RowPortalMenu({
  x,
  y,
  align = "start",
  items,
  onClose,
}: {
  /** 锚点 X：align=start 时为菜单左边对齐位置；align=end 时为菜单右边对齐位置。 */
  x: number;
  y: number;
  align?: "start" | "end";
  items: MenuItemSpec[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLUListElement | null>(null);
  // 初始放屏外避免首帧闪在错位置；useLayoutEffect 测量后立即贴正确坐标。
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: -9999,
    top: -9999,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === "end" ? x - rect.width : x;
    let top = y;
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
    if (left < 8) left = 8;
    if (top + rect.height > vh - 8) top = Math.max(8, y - rect.height);
    setPos({ left, top });
  }, [x, y, align]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <ul
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 100 }}
      className="min-w-[180px] border border-te-gray/60 bg-te-bg py-1 shadow-lg"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <li key={it.key}>
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onSelect();
              onClose();
            }}
            className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-[0.15em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              it.danger
                ? "text-[#ff4d4d] hover:bg-[#ff4d4d]/10 disabled:hover:bg-transparent"
                : "text-te-fg hover:bg-te-surface-hover hover:text-te-accent disabled:hover:bg-transparent"
            }`}
            title={it.hint}
          >
            <span className="shrink-0 [&>svg]:size-3.5">{it.icon}</span>
            <span className="flex-1 text-left">{it.label}</span>
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  );
}

function RowActions({
  status,
  retrying,
  onRetry,
  onCopy,
  onMore,
  retryDisabled,
  retryTitle,
  copied,
}: {
  status: HistoryStatus;
  retrying: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onMore: (e: React.MouseEvent<HTMLButtonElement>) => void;
  retryDisabled: boolean;
  retryTitle: string;
  copied: boolean;
}) {
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";
  const baseBtn =
    "inline-flex size-7 items-center justify-center border border-transparent text-te-light-gray transition-colors hover:border-te-gray/60 hover:text-te-accent";
  const moreBtn = (
    <button
      type="button"
      onClick={onMore}
      className={baseBtn}
      title={t("pages:history.more")}
      aria-haspopup="menu"
    >
      <MoreHorizontal className="size-3.5" />
    </button>
  );

  // 失败态/取消态：保留大「重试/转入」常显按钮，旁边 "..." 永远显示（不再 hover-only），
  // 删除等次要操作折叠进菜单。
  if (isFailed || isCancelled) {
    const label = isCancelled
      ? t("pages:history.row.transcribe")
      : t("pages:history.row.retry");
    return (
      <div className="flex items-center gap-1">
        {moreBtn}
        <button
          type="button"
          disabled={retryDisabled}
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 border border-te-gray/40 bg-te-surface px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-te-fg transition-colors hover:border-te-accent hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-te-gray/40 disabled:hover:text-te-fg"
          title={retryTitle}
        >
          {retrying ? (
            <Loader2 className="size-3 animate-spin" strokeWidth={2} />
          ) : (
            <RotateCcw className="size-3" strokeWidth={2} />
          )}
          <span>
            {retrying ? t("pages:history.row.retrying_label") : label}
          </span>
        </button>
      </div>
    );
  }

  // 成功态 hover 时显示：复制 + "..."（其它操作都进菜单 / 右键）。
  return (
    <div className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
      <button
        type="button"
        className={baseBtn}
        title={
          copied ? t("pages:history.row.copied") : t("pages:history.row.copy")
        }
        onClick={onCopy}
      >
        {copied ? (
          <Check className="size-3.5" strokeWidth={2.5} />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
      {moreBtn}
    </div>
  );
}

function RefinedToggle({
  showRaw,
  onToggle,
  type,
  targetLang,
}: {
  showRaw: boolean;
  onToggle: (next: boolean) => void;
  type: HistoryType;
  targetLang?: string | null;
}) {
  const { t } = useTranslation();
  const baseCls =
    "rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors";
  const activeCls = "bg-te-fg text-te-bg";
  const inactiveCls = "text-te-light-gray hover:text-te-fg";
  const langLabel =
    targetLang
      ? t(`settings:translate_target_lang.${targetLang}`, {
          defaultValue: "",
        })
      : "";
  const refinedLabel =
    type === "translate"
      ? langLabel || t("pages:history.row.view_translation")
      : t("pages:history.row.view_refined");
  return (
    <div className="inline-flex items-center gap-1 rounded-sm border border-te-gray/30 p-0.5">
      <button
        type="button"
        className={`${baseCls} ${!showRaw ? activeCls : inactiveCls}`}
        onClick={() => onToggle(false)}
      >
        {refinedLabel}
      </button>
      <button
        type="button"
        className={`${baseCls} ${showRaw ? activeCls : inactiveCls}`}
        onClick={() => onToggle(true)}
      >
        {t("pages:history.row.view_raw")}
      </button>
    </div>
  );
}

function statusBadgeCls(status: HistoryStatus): string {
  if (status === "failed")
    return "border-[#ff4d4d]/60 bg-[#ff4d4d]/15 text-[#ff4d4d]";
  if (status === "cancelled")
    return "border-te-gray/40 bg-transparent text-te-light-gray";
  return "border-te-accent/50 bg-te-accent/10 text-te-accent";
}

type DetailActionVariant = "default" | "primary" | "danger";

function DetailActionButton({
  icon,
  label,
  onClick,
  disabled,
  title,
  variant = "default",
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  variant?: DetailActionVariant;
}) {
  const base =
    "inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const styles =
    variant === "danger"
      ? "border border-[#ff4d4d]/50 text-[#ff4d4d] hover:border-[#ff4d4d] hover:bg-[#ff4d4d]/10 disabled:hover:border-[#ff4d4d]/50 disabled:hover:bg-transparent"
      : variant === "primary"
        ? "border border-te-accent/60 bg-te-accent/10 text-te-accent hover:bg-te-accent/20 disabled:hover:bg-te-accent/10"
        : "border border-te-gray/50 text-te-fg hover:border-te-accent hover:text-te-accent disabled:hover:border-te-gray/50 disabled:hover:text-te-fg";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${styles}`}
    >
      <span className="shrink-0 [&>svg]:size-3.5">{icon}</span>
      <span>{label}</span>
    </button>
  );
}


type DebugMode = "simulate" | "refine" | "reinject";

function DebugStrip({
  item,
  currentText,
  onClose,
}: {
  item: HistoryItem;
  currentText: string;
  onClose: () => void;
}) {
  const recordingState = useRecordingStore((s) => s.state);
  const simulate = useRecordingStore((s) => s.simulateDictationFromAudio);
  const refineOnly = useRecordingStore((s) => s.debugRefineOnly);
  const reinject = useRecordingStore((s) => s.debugReinject);
  const cancelDebug = useRecordingStore((s) => s.simulateCancel);
  const [running, setRunning] = useState<DebugMode | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [refineResult, setRefineResult] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickerRef = useRef<number | null>(null);

  // simulate 走全局 FSM；其它两个是本地 promise——running 状态混合两种来源。
  // recordingState 离开 idle 但 running !== "simulate"：说明真用户触发了快捷键，
  // 与 debug 无关，按钮置灰防止并发 invoke。
  const externalBusy = recordingState !== "idle" && running !== "simulate";

  const startTicker = () => {
    startedAtRef.current = performance.now();
    setElapsedMs(0);
    if (tickerRef.current !== null) window.clearInterval(tickerRef.current);
    tickerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current);
    }, 200);
  };
  const stopTicker = () => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  };

  useEffect(() => {
    return () => stopTicker();
  }, []);

  // simulate 模式靠 FSM 通知"跑完了"——我们不能 await（会被 onClose 卡住），所以
  // 监听 recordingState 回 idle 来收尾。refine/reinject 是普通 await，自己管。
  useEffect(() => {
    if (running === "simulate" && recordingState === "idle") {
      stopTicker();
      setRunning(null);
    }
  }, [running, recordingState]);

  const handleSimulate = () => {
    if (running) return;
    if (!item.audio_path) return;
    setRunning("simulate");
    setRefineResult(null);
    startTicker();
    void simulate(item.audio_path, item.duration_ms).catch((e) => {
      console.warn("[debug] simulate failed:", e);
      stopTicker();
      setRunning(null);
    });
  };

  const handleRefine = async () => {
    if (running) return;
    if (!currentText.trim()) {
      toast.warning("[DEBUG] 没有可优化的文本");
      return;
    }
    setRunning("refine");
    setRefineResult(null);
    startTicker();
    try {
      const refined = await refineOnly(currentText);
      setRefineResult(refined);
      toast.success("[DEBUG] AI 优化完成", {
        description: `${refined.length} chars`,
      });
    } catch (e) {
      console.warn("[debug] refine failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("[DEBUG] AI 优化失败", { description: msg });
    } finally {
      stopTicker();
      setRunning(null);
    }
  };

  const handleReinject = async () => {
    if (running) return;
    const text = currentText.trim();
    if (!text) {
      toast.warning("[DEBUG] 没有可注入的文本");
      return;
    }
    setRunning("reinject");
    startTicker();
    try {
      // 关闭 dialog 让焦点回到目标输入框；inject_type 写到当前焦点。
      onClose();
      // 给 dialog 关闭动画一点时间，避免还焦在 dialog 上时敲键盘。
      await new Promise((r) => setTimeout(r, 120));
      await reinject(text);
      toast.success("[DEBUG] 已注入", {
        description: `${text.length} chars`,
      });
    } catch (e) {
      console.warn("[debug] reinject failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("[DEBUG] 注入失败", { description: msg });
    } finally {
      stopTicker();
      setRunning(null);
    }
  };

  const handleStop = () => {
    if (running === "simulate") {
      cancelDebug();
    }
    // refine / reinject 没有 abort 通道，按下视觉上没反应；UI 把 stop 仅暴露给 simulate
  };

  const stateLabel =
    running === "simulate"
      ? "RUNNING · SIMULATE"
      : running === "refine"
        ? "RUNNING · REFINE"
        : running === "reinject"
          ? "RUNNING · INJECT"
          : externalBusy
            ? "BUSY"
            : "IDLE";

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-dashed border-te-accent/40 bg-te-bg px-4 py-3">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-te-accent">
        <FlaskConical className="size-3" />
        <span>// DEBUG</span>
        <span className="text-te-light-gray/50">·</span>
        <span className="text-te-light-gray/70">不写历史 · 不影响真实流程</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {running === "simulate" ? (
          <DetailActionButton
            onClick={handleStop}
            variant="danger"
            icon={<X />}
            label="停止"
          />
        ) : (
          <DetailActionButton
            onClick={handleSimulate}
            disabled={!item.audio_path || !!running || externalBusy}
            title={
              !item.audio_path
                ? "无可用音频"
                : "用此录音跑完整听写：ASR → AI 优化 → 注入"
            }
            icon={<Play />}
            label="模拟听写"
          />
        )}
        <DetailActionButton
          onClick={() => void handleRefine()}
          disabled={!!running || externalBusy || !currentText.trim()}
          title="只跑一次 AI 优化，结果回填到下方"
          icon={<RotateCcw />}
          label="重跑 AI 优化"
        />
        <DetailActionButton
          onClick={() => void handleReinject()}
          disabled={!!running || externalBusy || !currentText.trim()}
          title="把当前显示的文本写到当前焦点应用（不转录、不优化）"
          icon={<Download />}
          label="重新注入"
        />
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-te-light-gray/70">
          {stateLabel}
          {running && (
            <span className="ml-2 text-te-accent">
              {(elapsedMs / 1000).toFixed(1)}s
            </span>
          )}
        </span>
      </div>
      {refineResult !== null && (
        <div className="mt-1 border border-te-gray/40 bg-te-surface-hover px-2 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-te-fg">
          <div className="mb-1 text-[9px] uppercase tracking-widest text-te-light-gray/60">
            // refined
          </div>
          {refineResult}
        </div>
      )}
    </div>
  );
}

function HistoryDetailDialog({
  open,
  onOpenChange,
  item,
  showRaw,
  setShowRaw,
  hasRefined,
  copied,
  retrying,
  canRetry,
  retryTitle,
  onCopy,
  onRetry,
  onExport,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item: HistoryItem;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  hasRefined: boolean;
  copied: boolean;
  retrying: boolean;
  canRetry: boolean;
  retryTitle: string;
  onCopy: () => void;
  onRetry: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isFailed = item.status === "failed";
  const isCancelled = item.status === "cancelled";

  const rawText = item.text?.trim() ?? "";
  const refinedText = (item.refined_text ?? "").trim();
  const showingRefined = hasRefined && !showRaw;
  const mainText = isFailed
    ? t("pages:history.row.failed_placeholder")
    : isCancelled
      ? t("pages:history.row.cancelled_placeholder", {
          duration: formatDuration(item.duration_ms),
        })
      : showingRefined
        ? refinedText || rawText
        : rawText;

  const handleDeleteClick = () => {
    onOpenChange(false);
    onDelete();
  };

  // 关 dialog 时如果 debug 模拟还在跑，强制取消，避免 overlay/inject 没有取消入口。
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      const rec = useRecordingStore.getState();
      if (rec.state !== "idle") rec.simulateCancel();
    }
    onOpenChange(v);
  };

  const showDebugStrip =
    import.meta.env.DEV && item.type === "dictation" && !!item.audio_path;
  const debugSourceText = (
    showingRefined ? (refinedText || rawText) : rawText
  ).trim();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="!flex h-[78vh] max-h-[760px] !flex-col !gap-0 rounded-none border border-te-gray bg-te-bg p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-3 border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <DialogTitle className="flex-1 font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
            {t("pages:history.detail.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("pages:history.detail.description")}
          </DialogDescription>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            className="inline-flex size-7 items-center justify-center border border-transparent text-te-light-gray transition-colors hover:border-te-gray/60 hover:text-te-accent"
            aria-label={t("actions.close")}
            title={t("actions.close")}
          >
            <X className="size-4" />
          </button>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-te-gray/30 px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
          <span className="text-te-fg">{formatFullDateTime(item.created_at)}</span>
          <TypeChip type={item.type} />
          <span
            className={`inline-flex items-center border px-1.5 py-px ${statusBadgeCls(item.status)}`}
          >
            {t(`pages:history.status.${item.status}`)}
          </span>
          {item.duration_ms > 0 && (
            <span>
              <span className="text-te-light-gray/60">
                {t("pages:history.detail.meta.duration")}
              </span>{" "}
              {formatDuration(item.duration_ms)}
            </span>
          )}
          {item.target_app && (
            <span>
              <span className="text-te-light-gray/60">→</span> {item.target_app}
            </span>
          )}
          {item.segment_mode && (
            <span>
              <span className="text-te-light-gray/60">
                {t("pages:history.detail.meta.segment_mode")}
              </span>{" "}
              {t(`pages:history.detail.segment_mode.${item.segment_mode}`)}
            </span>
          )}
          {item.provider_kind && (
            <span>
              <span className="text-te-light-gray/60">
                {t("pages:history.detail.meta.provider_kind")}
              </span>{" "}
              {t(`pages:history.detail.provider_kind.${item.provider_kind}`, {
                defaultValue: item.provider_kind,
              })}
            </span>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
          {hasRefined && !isFailed && !isCancelled && (
            <div className="mb-3 flex shrink-0 items-center gap-2">
              <RefinedToggle
                showRaw={showRaw}
                onToggle={setShowRaw}
                type={item.type}
                targetLang={item.target_lang}
              />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {mainText ? (
            <p
              className={`font-sans text-sm leading-relaxed break-words whitespace-pre-wrap select-text ${
                isFailed
                  ? "text-[#ff4d4d]"
                  : isCancelled
                    ? "text-te-light-gray/80"
                    : "text-te-fg"
              }`}
            >
              {mainText}
            </p>
          ) : (
            <p className="font-mono text-xs uppercase tracking-widest text-te-light-gray/60">
              {t("pages:history.detail.empty_text")}
            </p>
          )}
          {isFailed && item.error && (
            <div className="mt-4 border-t border-[#ff4d4d]/30 pt-3 font-mono text-[11px] uppercase tracking-widest break-all text-[#ff4d4d]/80">
              <span className="text-[#ff4d4d]/60">
                {t("pages:history.detail.meta.error")}:
              </span>{" "}
              {item.error}
            </div>
          )}
          {!isFailed && item.error && (
            <div className="mt-4 border-t border-amber-400/30 pt-3 font-mono text-[11px] uppercase tracking-widest break-all text-amber-400/90">
              <span className="text-amber-400/60">
                {t("pages:history.detail.meta.warn")}:
              </span>{" "}
              {item.error}
            </div>
          )}
          </div>
        </div>

        {item.audio_path && (
          <AudioWavePlayer
            audioPath={item.audio_path}
            fallbackDurationMs={item.duration_ms}
          />
        )}

        {showDebugStrip && (
          <DebugStrip
            item={item}
            currentText={debugSourceText}
            onClose={() => handleOpenChange(false)}
          />
        )}

        <DialogFooter className="m-0 flex shrink-0 flex-row flex-wrap items-center gap-x-3 gap-y-2 rounded-none border-t border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <ModelMeta item={item} />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!isFailed && !isCancelled && rawText && (
            <DetailActionButton
              onClick={onCopy}
              icon={copied ? <Check strokeWidth={2.5} /> : <Copy />}
              label={
                copied
                  ? t("pages:history.row.copied")
                  : t("pages:history.row.copy")
              }
            />
          )}
          {(isFailed || isCancelled) && (
            <DetailActionButton
              onClick={onRetry}
              disabled={!canRetry}
              title={retryTitle}
              variant="primary"
              icon={
                retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />
              }
              label={
                retrying
                  ? t("pages:history.row.retrying_label")
                  : isCancelled
                    ? t("pages:history.row.transcribe")
                    : t("pages:history.row.retry")
              }
            />
          )}
          {item.audio_path && (
            <DetailActionButton
              onClick={onExport}
              icon={<Download />}
              label={t("pages:history.row.export")}
            />
          )}
          <DetailActionButton
            onClick={handleDeleteClick}
            variant="danger"
            icon={<Trash2 />}
            label={t("pages:history.row.delete")}
          />
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelMeta({ item }: { item: HistoryItem }) {
  const { t } = useTranslation();
  if (!item.asr_source && !item.ai_model) return null;
  const asrLabel = item.asr_source
    ? t(`pages:history.detail.asr.${item.asr_source}`)
    : null;
  const aiLabel = item.ai_model ?? t("pages:history.detail.ai.none");
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-[11px] leading-tight text-te-fg">
      {asrLabel && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray/60">
            {t("pages:history.detail.meta.asr")}
          </span>
          <span className="truncate">{asrLabel}</span>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray/60">
          {t("pages:history.detail.meta.ai")}
        </span>
        <span className="truncate">{aiLabel}</span>
      </div>
    </div>
  );
}

function HistoryRow({ item, index }: { item: HistoryItem; index: number }) {
  const { t } = useTranslation();
  const isFailed = item.status === "failed";
  const isCancelled = item.status === "cancelled";
  const retry = useHistoryStore((s) => s.retry);
  const remove = useHistoryStore((s) => s.remove);
  const retrying = useHistoryStore((s) => s.retryingIds.has(item.id));
  const playingId = usePlaybackStore((s) => s.playingId);
  const playbackPlaying = usePlaybackStore((s) => s.isPlaying);
  const togglePlay = usePlaybackStore((s) => s.toggle);
  const isPlaying = playingId === item.id && playbackPlaying;
  const hasRefined = !isFailed && !isCancelled && !!item.refined_text;
  // 默认显示 refined（AI 优化后的书面化文本）；用户可切回原始 ASR 文本对照。
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuPos, setMenuPos] = useState<
    { x: number; y: number; align: "start" | "end" } | null
  >(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const displayText = isFailed
    ? t("pages:history.row.failed_placeholder")
    : isCancelled
      ? t("pages:history.row.cancelled_placeholder", {
          duration: formatDuration(item.duration_ms),
        })
      : hasRefined && !showRaw
        ? (item.refined_text as string)
        : item.text;
  const copyableText = displayText;

  const handleRetry = async () => {
    try {
      await retry(item.id);
      toast.success(t("pages:history.toast.retry_success"));
    } catch (e) {
      // 未登录拦截已经弹了登录框，不再叠 toast 干扰。
      if (e instanceof NotAuthenticatedError) return;
      console.error("[history] retry failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t("pages:history.toast.retry_failed"), { description: msg });
    }
  };

  const handleDelete = async () => {
    try {
      await remove(item.id);
    } catch (e) {
      console.error("[history] delete failed:", e);
      toast.error(t("pages:history.toast.delete_failed"));
    }
  };

  const handleCopy = async () => {
    if (!copyableText) return;
    try {
      await writeText(copyableText);
      setCopied(true);
      toast.success(t("pages:history.toast.copy_success"));
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error("[history] copy failed:", e);
      toast.error(t("pages:history.toast.copy_failed"));
    }
  };

  const handleExport = async () => {
    if (!item.audio_path) return;
    const audioPath = item.audio_path;
    // audio_path 形如 "recordings/<id>.ogg"（新版）或 ".wav"（迁移前老库）。
    const isOgg = audioPath.toLowerCase().endsWith(".ogg");
    const defaultName =
      audioPath.split("/").pop() ||
      (isOgg ? "openspeech-recording.ogg" : "openspeech-recording.wav");
    let dest: string | null;
    try {
      dest = await saveFileDialog({
        defaultPath: defaultName,
        filters: isOgg
          ? [{ name: "OGG", extensions: ["ogg"] }]
          : [{ name: "WAV", extensions: ["wav"] }],
      });
    } catch (e) {
      console.error("[history] save dialog failed:", e);
      toast.error(t("pages:history.toast.export_failed"));
      return;
    }
    if (!dest) return;
    try {
      await exportRecordingTo(audioPath, dest);
      toast.success(t("pages:history.toast.export_success"));
    } catch (e) {
      console.error("[history] export failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t("pages:history.toast.export_failed"), { description: msg });
    }
  };

  // 长录音（>5min）暂走不通——OL-TL-004 只接受公网 URL。在 UI 层提前禁用按钮，
  // 给出 title 提示，避免用户点击后才看到 toast。
  const tooLong = item.duration_ms > 5 * 60 * 1000;
  const canRetry = !!item.audio_path && !tooLong && !retrying;
  const retryTitle = !item.audio_path
    ? t("pages:history.row.retry_no_audio")
    : tooLong
      ? t("pages:history.row.retry_too_long")
      : retrying
        ? t("pages:history.row.retry_in_progress")
        : t("pages:history.row.retry_tooltip");

  // 菜单项构造：右键菜单 + "..." 折叠菜单共用同一份内容。
  // 复制按钮是行外常显的次要快捷键，菜单里仍然提供（右键场景没有外部按钮）。
  // 播放 / 重试 / 下载 / 删除 / DEBUG（dev only）按场景动态裁剪。
  const buildMenuItems = (): MenuItemSpec[] => {
    const items: MenuItemSpec[] = [];
    items.push({
      key: "details",
      label: t("pages:history.row.view_details"),
      icon: <Eye />,
      onSelect: () => setDetailOpen(true),
    });
    if (!isFailed && !isCancelled) {
      items.push({
        key: "copy",
        label: t("pages:history.row.copy"),
        icon: <Copy />,
        onSelect: () => void handleCopy(),
      });
    }
    if (item.audio_path) {
      items.push({
        key: "play",
        label: isPlaying
          ? t("pages:history.row.pause")
          : t("pages:history.row.play"),
        icon: isPlaying ? <Pause /> : <Play />,
        onSelect: () => void togglePlay(item.id, item.audio_path as string),
      });
    }
    items.push({
      key: "retry",
      label: isCancelled
        ? t("pages:history.row.transcribe")
        : t("pages:history.row.retry"),
      icon: retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />,
      disabled: !canRetry,
      hint: retryTitle,
      onSelect: () => void handleRetry(),
    });
    if (item.audio_path) {
      items.push({
        key: "export",
        label: t("pages:history.row.export"),
        icon: <Download />,
        onSelect: () => void handleExport(),
      });
    }
    items.push({
      key: "delete",
      label: t("pages:history.row.delete"),
      icon: <Trash2 />,
      danger: true,
      onSelect: () => void handleDelete(),
    });
    return items;
  };

  const openMenuAt = (x: number, y: number, align: "start" | "end" = "start") =>
    setMenuPos({ x, y, align });
  const closeMenu = () => setMenuPos(null);

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
      onContextMenu={(e) => {
        e.preventDefault();
        openMenuAt(e.clientX, e.clientY);
      }}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (
          target?.closest(
            'button, a, select, input, textarea, [role="menu"], [role="menuitem"]',
          )
        ) {
          return;
        }
        // 清掉双击带来的文本选择，避免 dialog 关闭后行内一段被选中的视觉干扰。
        window.getSelection()?.removeAllRanges();
        setDetailOpen(true);
      }}
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
            isFailed
              ? "text-[#ff4d4d]"
              : isCancelled
                ? "text-te-light-gray/70"
                : "text-te-fg"
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
        {hasRefined && (
          <div className="mt-1.5 flex items-center gap-2">
            <RefinedToggle
              showRaw={showRaw}
              onToggle={setShowRaw}
              type={item.type}
              targetLang={item.target_lang}
            />
            {item.duration_ms > 0 && (
              <span className="font-mono text-[10px] tracking-widest text-te-light-gray/50">
                {formatDuration(item.duration_ms)}
              </span>
            )}
          </div>
        )}
        {!hasRefined && !isFailed && !isCancelled && item.duration_ms > 0 && (
          <div className="mt-1.5 font-mono text-[10px] tracking-widest text-te-light-gray/50">
            {formatDuration(item.duration_ms)}
          </div>
        )}
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
        {!isFailed && item.error && (
          <div className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-400/80">
            {t("pages:history.detail.meta.warn")}: {item.error}
          </div>
        )}
      </div>

      {/* 操作区：复制行外快捷 + "..." 折叠菜单（含播放/重试/下载/删除等）。
          状态徽标在最右侧；播放从外面挪进菜单里，避免按钮太密。 */}
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <RowActions
          status={item.status}
          retrying={retrying}
          retryDisabled={!canRetry}
          retryTitle={retryTitle}
          copied={copied}
          onRetry={() => void handleRetry()}
          onCopy={() => void handleCopy()}
          onMore={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            // 菜单从 "..." 按钮的右边对齐向左展开，避免被屏幕边或滚动条压住。
            openMenuAt(r.right, r.bottom + 4, "end");
          }}
        />
      </div>

      {menuPos && (
        <RowPortalMenu
          x={menuPos.x}
          y={menuPos.y}
          align={menuPos.align}
          items={buildMenuItems()}
          onClose={closeMenu}
        />
      )}

      <HistoryDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        item={item}
        showRaw={showRaw}
        setShowRaw={setShowRaw}
        hasRefined={hasRefined}
        copied={copied}
        retrying={retrying}
        canRetry={canRetry}
        retryTitle={retryTitle}
        onCopy={() => void handleCopy()}
        onRetry={() => void handleRetry()}
        onExport={() => void handleExport()}
        onDelete={() => void handleDelete()}
      />
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
  const { t } = useTranslation();
  return (
    <motion.div
      className="flex flex-col items-center justify-center py-24"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <span className="font-mono text-sm uppercase tracking-widest text-te-light-gray">
        {t("pages:history.empty")}
      </span>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const { t } = useTranslation();
  const items = useHistoryStore((s) => s.items);
  const clearAllInDb = useHistoryStore((s) => s.clearAll);
  const reload = useHistoryStore((s) => s.reload);
  const openStats = useUIStore((s) => s.openStats);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [query, setQuery] = useState("");
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    const minSpin = new Promise((r) => setTimeout(r, 500));
    try {
      await Promise.all([reload(), minSpin]);
    } catch (e) {
      console.error("[history] refresh failed:", e);
      toast.error(t("pages:history.toast.refresh_failed"));
    } finally {
      setRefreshing(false);
    }
  };

  const filtered = useMemo(() => {
    const base = filter === "all" ? items : items.filter((it) => it.type === filter);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((it) => {
      if (it.text.toLowerCase().includes(q)) return true;
      if (it.refined_text?.toLowerCase().includes(q)) return true;
      if (it.target_app?.toLowerCase().includes(q)) return true;
      if (it.error?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [items, filter, query]);

  // 切换 filter / 搜索词时重置分页并把滚动条拉回顶部，避免用户停在已不存在的"第 N 页"。
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filter, query]);

  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const hasMore = filtered.length > visibleCount;

  // 滚到底部哨兵进入视口 → 追加下一页。rootMargin 提前 400px 触发，让用户感觉不到等待。
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => c + PAGE_SIZE);
        }
      },
      { root, rootMargin: "400px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore]);

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
    for (const it of visible) {
      map[bucketOf(it.created_at)].push(it);
    }
    // 每组内按时间倒序（id 是日期增量，直接字典序倒排即时间倒序）
    for (const k of BUCKET_ORDER) {
      map[k].sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
    }
    return map;
  }, [visible]);

  return (
    <section className="flex h-full flex-col bg-te-bg">
      {/* 顶部固定：标题 + 操作按钮（可拖窗，按钮豁免） */}
      <div data-tauri-drag-region className="shrink-0 bg-te-bg">
        <div
          data-tauri-drag-region
          className="mx-auto max-w-5xl px-[4vw] pt-3 pb-4"
        >
          <motion.div
            data-tauri-drag-region
            className="flex flex-col gap-2"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <div
              data-tauri-drag-region
              className="flex items-center justify-between gap-4"
            >
              <h1 className="font-mono text-3xl font-bold tracking-tighter text-te-fg">
                {t("pages:history.title")}
              </h1>
              <div
                className="flex items-center gap-2"
                data-tauri-drag-region="false"
              >
                <button
                  type="button"
                  onClick={() => openStats()}
                  className="inline-flex size-9 items-center justify-center border border-te-gray/40 text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
                  title={t("pages:history.stats")}
                  aria-label={t("pages:history.stats")}
                >
                  <BarChart3 className="size-4" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={refreshing}
                  className="inline-flex size-9 items-center justify-center border border-te-gray/40 text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-te-gray/40 disabled:hover:text-te-light-gray"
                  title={t("pages:history.refresh")}
                  aria-label={t("pages:history.refresh")}
                >
                  <RefreshCw
                    className={`size-4 ${refreshing ? "animate-spin" : ""}`}
                    strokeWidth={2}
                  />
                </button>
                <MoreMenu
                  onClear={() => setConfirmClearOpen(true)}
                  onOpenFolder={() => {
                    void invoke("open_recordings_dir").catch((e) => {
                      console.warn("[history] open recordings dir failed:", e);
                      toast.error(t("pages:history.open_folder_failed"));
                    });
                  }}
                  clearDisabled={items.length === 0}
                />
              </div>
            </div>
            <div
              data-tauri-drag-region
              className="flex items-center justify-between gap-4"
            >
              <p className="text-xs leading-relaxed text-te-light-gray">
                {t("pages:history.subtitle")}
              </p>
              <div data-tauri-drag-region="false">
                <RetentionSelect />
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* 中部固定：筛选 Tabs + 搜索 */}
      <div data-tauri-drag-region className="shrink-0 bg-te-bg">
        <div data-tauri-drag-region className="mx-auto max-w-5xl px-[4vw]">
          <div className="flex items-center justify-between gap-4 border-b border-te-gray/40">
            <FilterTabs value={filter} onChange={setFilter} />
            <div className="flex items-center gap-2">
              <SearchBox
                value={query}
                onChange={setQuery}
                placeholder={t("pages:history.search_placeholder")}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 滚动区：历史列表 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
                    {bucket !== "TODAY" && (
                      <GroupHeader
                        label={t(
                          `pages:history.buckets.${BUCKET_I18N_KEY[bucket]}`,
                        )}
                      />
                    )}
                    <div>
                      {rows.map((item, i) => (
                        <HistoryRow key={item.id} item={item} index={i} />
                      ))}
                    </div>
                  </div>
                );
              })}
              <div
                ref={sentinelRef}
                className="flex items-center justify-center py-6 font-mono text-[10px] uppercase tracking-widest text-te-light-gray/50"
              >
                {hasMore
                  ? t("pages:history.loading_more")
                  : filtered.length > PAGE_SIZE
                    ? t("pages:history.list_end", { count: filtered.length })
                    : null}
              </div>
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
  onOpenFolder,
  clearDisabled,
}: {
  onClear: () => void;
  onOpenFolder: () => void;
  clearDisabled?: boolean;
}) {
  const { t } = useTranslation();
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
        title={t("pages:history.more")}
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
            className="absolute right-0 z-20 mt-2 w-max border border-te-gray/60 bg-te-bg py-1"
          >
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenFolder();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] text-te-fg transition-colors hover:bg-te-surface-hover hover:text-te-accent"
              >
                <FolderOpen className="size-3.5" />
                <span>{t("pages:history.open_folder")}</span>
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
                disabled={clearDisabled}
                className="flex w-full items-center gap-2 whitespace-nowrap px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] text-[#ff4d4d] transition-colors hover:bg-[#ff4d4d]/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Trash2 className="size-3.5" />
                <span>{t("pages:history.delete_all")}</span>
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
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!gap-0 rounded-none border border-te-gray bg-te-bg p-0 sm:max-w-md">
        <DialogHeader className="border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <DialogTitle className="font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
            {t("pages:history.confirm_clear.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("pages:history.confirm_clear.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-5 text-sm leading-relaxed text-te-fg">
          <Trans
            i18nKey="pages:history.confirm_clear.body"
            values={{ count }}
            components={{
              count: <span className="font-mono text-te-accent" />,
            }}
          />
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("pages:history.confirm_clear.tip")}
          </p>
        </div>

        <DialogFooter className="flex flex-row justify-end gap-2 border-t border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="border border-te-gray/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          >
            {t("actions.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-[#ff4d4d] px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-white transition-[filter] hover:brightness-110"
          >
            {t("pages:history.confirm_clear.confirm")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
