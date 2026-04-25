import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { PulsarGrid } from "@/components/PulsarGrid";
import { cn } from "@/lib/utils";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useRecordingStore, type RecordingState } from "@/stores/recording";
import {
  codeToMod,
  formatCode,
  normalizeMods,
  type HotkeyBinding,
  type HotkeyMod,
  type HotkeyMode,
} from "@/lib/hotkey";
import { detectPlatform, type Platform } from "@/lib/platform";

/* ──────────────────────────────────────────────────────────────── */
/*  Hotkey preview — 按键监听                                        */
/* ──────────────────────────────────────────────────────────────── */

type KeyToken = { id: string; label: string };

// 首页的听写快捷键 token：与 settings 里的 dictate_ptt binding 保持同源。
type HotkeyToken =
  | { kind: "mod"; mod: HotkeyMod; label: string; icon: string | null }
  | { kind: "main"; code: string; label: string; icon: string | null }
  | { kind: "prefix"; label: string };

function modLabel(mod: HotkeyMod, platform: Platform): string {
  if (mod === "fn") return "Fn";
  if (mod === "shift") return "Shift";
  if (mod === "alt") return platform === "macos" ? "Option" : "Alt";
  if (mod === "ctrl") return "Ctrl";
  if (platform === "macos") return "Cmd";
  if (platform === "windows") return "Win";
  return "Super";
}

// 修饰键的视觉图标：macOS 用传统符号 (⌃⌥⇧⌘)，Windows 用 ⊞（Win 键），Linux 用 ◆（Super）
// fn 没有通用图形符号，label 已经写着 "Fn"，不再重复渲染图标
function modIcon(mod: HotkeyMod, platform: Platform): string | null {
  if (mod === "fn") return null;
  if (mod === "ctrl") return "⌃";
  if (mod === "shift") return "⇧";
  if (mod === "alt") return "⌥";
  // meta
  if (platform === "macos") return "⌘";
  if (platform === "windows") return "⊞";
  return "◆";
}

// 非字母数字主键的图标（箭头已经由 formatCode 返回图形字符，这里补 Enter / Esc 等）
const MAIN_ICON: Record<string, string> = {
  Enter: "↵",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "␣",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function mainIcon(code: string): string | null {
  return MAIN_ICON[code] ?? null;
}

function tokensFromBinding(
  binding: HotkeyBinding | null,
  platform: Platform,
): HotkeyToken[] {
  if (!binding) return [];
  const tokens: HotkeyToken[] = [];
  if (binding.kind === "doubleTap") {
    tokens.push({ kind: "prefix", label: "2×" });
  }
  // 应用当前 MOD_ORDER，确保 fn 排最前（老存档也会重新排序）
  for (const mod of normalizeMods(binding.mods)) {
    tokens.push({
      kind: "mod",
      mod,
      label: modLabel(mod, platform),
      icon: modIcon(mod, platform),
    });
  }
  if (binding.kind === "combo" && binding.code) {
    tokens.push({
      kind: "main",
      code: binding.code,
      label: formatCode(binding.code),
      icon: mainIcon(binding.code),
    });
  }
  return tokens;
}

function tokenMatches(token: HotkeyToken, pressed: KeyToken | null): boolean {
  if (!pressed) return false;
  if (token.kind === "mod") return codeToMod(pressed.id) === token.mod;
  if (token.kind === "main") return token.code === pressed.id;
  return false;
}

const CODE_LABEL: Record<string, string> = {
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  MetaLeft: "Left Cmd",
  MetaRight: "Right Cmd",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Del",
  CapsLock: "Caps",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function keyFromEvent(e: KeyboardEvent): KeyToken {
  if (e.key === "Fn") return { id: "Fn", label: "Fn" };
  const code = e.code;
  if (CODE_LABEL[code]) return { id: code, label: CODE_LABEL[code] };
  if (/^Key[A-Z]$/.test(code)) return { id: code, label: code.slice(3) };
  if (/^Digit\d$/.test(code)) return { id: code, label: code.slice(5) };
  if (/^F\d+$/.test(code)) return { id: code, label: code };
  if (/^Numpad(.+)$/.test(code)) return { id: code, label: `Num${code.slice(6)}` };
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return { id: code || k, label: k || code };
}

// 过滤识别失败的按键：rdev 0.5 对未映射的硬件键 fallback 成
// `Key::Unknown(u32)` / `Key::RawKey(_)`，到 Rust → 前端就成了
// "Unknown(123)" / "RawKey(...)"；DOM 在某些 IME / 媒体键场景
// 也会给 "Unidentified"。这些都不该作为视觉反馈显示给用户。
function isDisplayableKey(token: KeyToken): boolean {
  const id = token.id || "";
  const label = token.label || "";
  if (!id || !label) return false;
  if (id === "Unidentified" || label === "Unidentified") return false;
  if (id.startsWith("Unknown(") || id.startsWith("RawKey(")) return false;
  return true;
}

/* ──────────────────────────────────────────────────────────────── */
/*  Local components                                                  */
/* ──────────────────────────────────────────────────────────────── */

function Kbd({
  children,
  highlight,
}: {
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border bg-te-bg px-3 py-1.5 font-mono text-sm transition-colors",
        highlight
          ? "border-te-accent text-te-accent shadow-[inset_0_-2px_0_0_var(--te-accent)]"
          : "border-te-gray text-te-fg shadow-[inset_0_-2px_0_0_var(--te-gray)]",
      )}
    >
      {children}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Live dictation panel — 按下听写快捷键后替换快捷键卡片            */
/* ──────────────────────────────────────────────────────────────── */

/**
 * 波形：把 recording store 里的 audioLevels（0..1 peak，20Hz 滑动窗口）画成 bars。
 * 选用 60 条刚好对应 ~3 秒历史；每帧 CSS height transition 做柔化，省 canvas。
 */
function Waveform({
  levels,
  active,
}: {
  levels: number[];
  active: boolean;
}) {
  return (
    <div className="flex h-16 w-full items-center gap-[2px]">
      {levels.map((v, i) => {
        // 0..1 映射到 8..100%；对数曲线让轻声的细微波动也可见
        const height = Math.max(8, Math.min(100, Math.pow(v, 0.55) * 110));
        return (
          <div
            key={i}
            className={cn(
              "flex-1 rounded-[1px] transition-[height] duration-75 ease-out",
              active ? "bg-te-accent" : "bg-te-gray/60",
            )}
            style={{ height: `${height}%` }}
          />
        );
      })}
    </div>
  );
}

/**
 * 文案矩阵：`primary` 是当前状态下的"主操作/进行中提示"；`secondary` 是 Esc 取消
 * 的副提示，两者语义不同必须分两行。hold / toggle 模式在 recording 态下操作方式
 * 不同（松开 vs 再按一次），preparing 态也略有差异。
 */
function statusCopy(
  state: RecordingState,
  mode: HotkeyMode,
): { tag: string; primary: string; secondary?: string } {
  switch (state) {
    case "preparing":
      return {
        tag: "// READY",
        primary: mode === "hold" ? "继续按住，开始说话…" : "开始说话…",
        secondary: "Esc 取消",
      };
    case "recording":
      return {
        tag: "// LISTENING",
        primary:
          mode === "hold"
            ? "松开快捷键 结束并转写"
            : "再按一次快捷键 结束并转写",
        secondary: "Esc 取消本次录音",
      };
    case "transcribing":
      return {
        tag: "// TRANSCRIBING",
        primary: "正在转写…",
        secondary: "Esc 放弃这次结果",
      };
    case "injecting":
      // 注入阶段只有几十毫秒，提 Esc 没意义——来不及撤回
      return { tag: "// INJECTING", primary: "正在写入输入框…" };
    case "error":
      return { tag: "// ERROR", primary: "出错了，检查日志或重试" };
    default:
      return { tag: "// IDLE", primary: "" };
  }
}

/**
 * Live 面板：state ≠ idle 时替换 HOTKEY CARD 主体。三栏布局：
 *   ┌──────────────┬───────────────────────────────┐
 *   │ 波形         │ 实时转写文字（OpenLoaf realtime ASR） │
 *   └──────────────┴───────────────────────────────┘
 * `liveTranscript` 由 recording store 在 asr-partial / asr-final 事件里更新；
 * recording 阶段展示 partial（accent 弱化），transcribing/injecting 展示 Final。
 */
function LiveDictationPanel({
  state,
  mode,
  audioLevels,
  liveTranscript,
}: {
  state: RecordingState;
  mode: HotkeyMode;
  audioLevels: number[];
  liveTranscript: string;
}) {
  const { tag, primary, secondary } = statusCopy(state, mode);
  const waveActive = state === "preparing" || state === "recording";
  const hasText = liveTranscript.trim().length > 0;
  // partial 态用 accent 色弱化提示"还在听"；Final 后状态机切 transcribing/injecting
  // 时用 te-fg 主色表示已定稿
  const textToneClass =
    state === "recording" || state === "preparing"
      ? "text-te-accent"
      : "text-te-fg";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-widest md:text-xs",
            state === "error" ? "text-te-accent" : "text-te-accent",
            waveActive && "animate-[pulse_1.2s_ease-in-out_infinite]",
          )}
        >
          {tag}
        </span>
        <span className="font-mono text-[10px] text-te-light-gray md:text-xs">
          {hasText ? `${liveTranscript.length} CHARS` : "LIVE"}
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-4 md:gap-6">
        {/* 左：音频波形 */}
        <div className="flex flex-col gap-2">
          <Waveform levels={audioLevels} active={waveActive} />
          <span className="font-mono text-[9px] uppercase tracking-widest text-te-light-gray md:text-[10px]">
            AUDIO · {audioLevels.length} SAMPLES
          </span>
        </div>

        {/* 右：realtime 转写流 */}
        <div className="flex min-h-[4rem] flex-col justify-between border-l border-te-gray/40 pl-4 md:pl-6">
          {/* max-h + overflow：文字很长时内部滚动，不撑爆卡片布局 */}
          <p
            className={cn(
              "font-sans text-xs leading-relaxed md:text-sm",
              "max-h-24 overflow-y-auto",
              hasText ? textToneClass : "text-te-fg/40",
            )}
          >
            {hasText ? liveTranscript : "实时转写文字将出现在这里…"}
          </p>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
              {primary}
            </span>
            {secondary ? (
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                {secondary}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

type StatProps = {
  index: string;
  label: string;
  value: string;
  unit?: string;
};

function StatCard({ index, label, value, unit }: StatProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4 }}
      className="group flex h-full flex-col justify-between border border-te-gray/60 bg-te-surface p-4 transition-colors hover:border-te-accent"
    >
      <div className="flex items-start justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
          {label}
        </span>
        <span className="font-mono text-[10px] text-te-light-gray">
          {index}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
          {value}
        </span>
        {unit ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
            {unit}
          </span>
        ) : null}
      </div>
    </motion.div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Page                                                             */
/* ──────────────────────────────────────────────────────────────── */

export default function HomePage() {
  const [pressed, setPressed] = useState<KeyToken | null>(null);
  // 首页快捷键展示与 settings 同源：读取 dictate_ptt 的实时 binding
  const binding = useHotkeysStore((s) => s.bindings.dictate_ptt);
  const platform = detectPlatform();
  const tokens = useMemo(
    () => tokensFromBinding(binding, platform),
    [binding, platform],
  );
  // hold / toggle 模式决定副标题文案
  const modeHint =
    binding?.mode === "toggle" ? "单击切换 · 再按停止" : "按住说话 · 松开插入";

  // 录音状态：非 idle 时 HOTKEY CARD 主体换成 Live 面板（波形 + realtime 转写）。
  // audioLevels 由 Rust `openspeech://audio-level` 事件驱动，liveTranscript 由
  // `openspeech://asr-partial` / `asr-final` 事件驱动——两者都在 recording store 维护。
  const recState = useRecordingStore((s) => s.state);
  const audioLevels = useRecordingStore((s) => s.audioLevels);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const isLive = recState !== "idle";

  // 按键预览：优先走 Rust `openspeech://key-preview`（rdev 无条件 emit，macOS 下
  // Fn 键只有这条路能拿到）；DOM keydown 作为兜底，覆盖 rdev 权限未授予 / Rust
  // 还没初始化好的极短窗口。两路写同一个 pressed state，以最后一个为准足够用。
  //
  // 防抖：短按（press/release 间隔很短）时高亮态只闪一帧就消失，看起来很抖；
  // 释放延迟 ~180ms 再清除 pressed，同时任何新的按下都会取消 pending 清除，
  // 连续按键也能平滑过渡。
  const clearTimerRef = useRef<number | null>(null);
  const applyPressed = useCallback((next: KeyToken | null) => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    if (next !== null) {
      setPressed(next);
      return;
    }
    clearTimerRef.current = window.setTimeout(() => {
      setPressed(null);
      clearTimerRef.current = null;
    }, 180);
  }, []);

  useEffect(
    () => () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tok = keyFromEvent(e);
      if (!isDisplayableKey(tok)) return;
      applyPressed(tok);
    };
    const clear = () => applyPressed(null);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", clear);
      window.removeEventListener("blur", clear);
    };
  }, [applyPressed]);

  useEffect(() => {
    let cancelled = false;
    let unsub: UnlistenFn | null = null;
    listen<{ code: string; phase: "pressed" | "released" }>(
      "openspeech://key-preview",
      (ev) => {
        const { code, phase } = ev.payload;
        if (phase === "pressed") {
          const tok: KeyToken = { id: code, label: CODE_LABEL[code] ?? code };
          if (!isDisplayableKey(tok)) return;
          applyPressed(tok);
        } else {
          applyPressed(null);
        }
      },
    ).then((un) => {
      if (cancelled) un();
      else unsub = un;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [applyPressed]);

  const pressedMatchesBinding = pressed
    ? tokens.some((t) => tokenMatches(t, pressed))
    : false;

  return (
    <section className="relative flex h-full flex-col overflow-hidden bg-te-bg">
      {/* PulsarGrid 背景动画：pointer-events-none 避免拦截 drag 区与卡片交互（PulsarGrid 自身用 window 级 mousemove，不依赖 canvas 捕获事件） */}
      <div className="pointer-events-none absolute inset-0">
        <PulsarGrid />
      </div>

      {/* 边缘径向遮罩：让四周淡出到 te-bg，中心区域保留动画细节 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 70% at 50% 45%, transparent 30%, var(--te-bg) 95%)",
        }}
      />

      {/* 顶部 drag 条 */}
      <div
        data-tauri-drag-region
        aria-hidden
        className="relative z-10 h-8 shrink-0"
      />

      {/* 内容总容器：三大块按 4:3:3 分配垂直空间（flex-basis 0 + grow 4/3/3） */}
      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden px-[clamp(1rem,4vw,2.5rem)] pt-[clamp(2rem,6vh,5rem)] pb-[clamp(1rem,3vw,2rem)]">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
          {/* ── 1. HERO (40%) ─────────────────────────────────── */}
          {/* 三行（h1 / paragraph / tags）在 40% 区域内 justify-between 上中下等距 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="flex min-h-0 flex-[4_1_0%] flex-col justify-between"
          >
            <h1 className="font-mono text-[clamp(1.75rem,5.5vw,4.5rem)] font-bold leading-[0.95] tracking-tighter text-te-fg">
              说出来。
              <br />
              <span className="text-te-accent">就成文。</span>
            </h1>

            <p className="max-w-xl font-sans text-sm leading-relaxed text-te-light-gray md:text-base">
              按住一个键，开口说话，文字即刻出现在任意应用中。不绑定编辑器，无订阅，无遥测。
            </p>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
              <span>// PUSH-TO-TALK 按键听写</span>
              <span>// BYO-MODEL</span>
              <span>// 本地优先</span>
            </div>
          </motion.div>

          {/* ── 2. HOTKEY CARD (30%) ──────────────────────────── */}
          {/* 卡片垂直居中于 30% 区域 */}
          <div className="flex min-h-0 flex-[3_1_0%] items-center">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: 0.03 }}
              className={cn(
                "w-full border bg-te-surface p-4 transition-colors md:p-5",
                isLive ? "border-te-accent/80" : "border-te-gray/60",
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                {isLive ? (
                  <motion.div
                    key="live"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                  >
                    <LiveDictationPanel
                      state={recState}
                      mode={binding?.mode ?? "hold"}
                      audioLevels={audioLevels}
                      liveTranscript={liveTranscript}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="preview"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                  >
                    <div className="flex items-start justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
                        听写快捷键 / PUSH-TO-TALK
                      </span>
                      <span className="font-mono text-[10px] text-te-light-gray md:text-xs">
                        01
                      </span>
                    </div>

                    <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="flex items-center gap-3">
                        {tokens.length === 0 ? (
                          <Kbd>未绑定</Kbd>
                        ) : pressed === null || pressedMatchesBinding ? (
                          tokens.map((t, i) => (
                            <Fragment key={i}>
                              {i > 0 && (
                                <span className="font-mono text-xl text-te-light-gray">
                                  +
                                </span>
                              )}
                              <Kbd highlight={tokenMatches(t, pressed)}>
                                {/* 特殊按键（修饰键 / 非字母主键）前缀一个图标 */}
                                {t.kind !== "prefix" && t.icon ? (
                                  <span aria-hidden className="mr-1.5 opacity-60">
                                    {t.icon}
                                  </span>
                                ) : null}
                                {t.label}
                              </Kbd>
                            </Fragment>
                          ))
                        ) : (
                          <Kbd>{pressed.label}</Kbd>
                        )}
                      </div>

                      <div className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
                        {modeHint}
                      </div>
                    </div>

                    <p className="mt-3 max-w-2xl font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
                      按住开始录音，松开即把转写结果写入当前输入框。按
                      <span className="mx-1 font-mono text-te-fg">Esc</span>
                      取消；焦点必须在可编辑区域。
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>

          {/* ── 3. STATS (30%) ────────────────────────────────── */}
          {/* 标题贴顶，卡片 grid 吸收剩余；卡片内部 h-full + justify-between 铺满 */}
          <div className="flex min-h-0 flex-[3_1_0%] flex-col">
            <div className="mb-2 flex shrink-0 items-end justify-between md:mb-3">
              <h2 className="font-mono text-base font-bold uppercase tracking-tighter text-te-fg md:text-lg">
                今日 / 本次会话
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                // LIVE METRICS
              </span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-4 gap-px bg-te-gray/40">
              <StatCard index="01" label="口述时长" value="00:00" unit="HH:MM" />
              <StatCard index="02" label="口述字数" value="0" unit="总计" />
              <StatCard index="03" label="平均速度" value="—" unit="WPM" />
              <StatCard index="04" label="节省时间" value="00:00" unit="HH:MM" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
