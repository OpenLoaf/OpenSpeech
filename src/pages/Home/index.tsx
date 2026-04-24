import { Fragment, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { PulsarGrid } from "@/components/PulsarGrid";
import { cn } from "@/lib/utils";

/* ──────────────────────────────────────────────────────────────── */
/*  Hotkey preview — 按键监听                                        */
/* ──────────────────────────────────────────────────────────────── */

type KeyToken = { id: string; label: string };

// 首页展示的"默认快捷键"是视觉占位（真实绑定由 hotkeys store 管，详见 docs/hotkeys.md）
const DEFAULT_KEYS: readonly KeyToken[] = [
  { id: "Fn", label: "Fn" },
  { id: "ControlLeft", label: "Left Ctrl" },
];

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

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      setPressed(keyFromEvent(e));
    };
    const clear = () => setPressed(null);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", clear);
    // 窗口失焦 / 隐藏时清空，避免卡在高亮态
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const matchedDefault = pressed
    ? DEFAULT_KEYS.find((k) => k.id === pressed.id)
    : undefined;

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
              className="w-full border border-te-gray/60 bg-te-surface p-4 md:p-5"
            >
              <div className="flex items-start justify-between">
                <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
                  默认快捷键 / PUSH-TO-TALK
                </span>
                <span className="font-mono text-[10px] text-te-light-gray md:text-xs">
                  01
                </span>
              </div>

              <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3">
                  {pressed === null || matchedDefault ? (
                    DEFAULT_KEYS.map((k, i) => (
                      <Fragment key={k.id}>
                        {i > 0 && (
                          <span className="font-mono text-xl text-te-light-gray">
                            +
                          </span>
                        )}
                        <Kbd highlight={matchedDefault?.id === k.id}>
                          {k.label}
                        </Kbd>
                      </Fragment>
                    ))
                  ) : (
                    <Kbd>{pressed.label}</Kbd>
                  )}
                </div>

                <div className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
                  按住说话 · 松开插入
                </div>
              </div>

              <p className="mt-3 max-w-2xl font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
                按住开始录音，松开即把转写结果写入当前输入框。按
                <span className="mx-1 font-mono text-te-fg">Esc</span>
                取消；焦点必须在可编辑区域。
              </p>
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
