import { motion, AnimatePresence } from "framer-motion";
import { PulsarGrid } from "@/components/PulsarGrid";
import { HotkeyPreview } from "@/components/HotkeyPreview";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { cn } from "@/lib/utils";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useRecordingStore } from "@/stores/recording";

/* ──────────────────────────────────────────────────────────────── */
/*  Stat card                                                        */
/* ──────────────────────────────────────────────────────────────── */

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
  const binding = useHotkeysStore((s) => s.bindings.dictate_ptt);
  const recState = useRecordingStore((s) => s.state);
  const audioLevels = useRecordingStore((s) => s.audioLevels);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const isLive = recState !== "idle";

  return (
    <section className="relative flex h-full flex-col overflow-hidden bg-te-bg">
      <div className="pointer-events-none absolute inset-0">
        <PulsarGrid />
      </div>

      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 70% at 50% 45%, transparent 30%, var(--te-bg) 95%)",
        }}
      />

      <div
        data-tauri-drag-region
        aria-hidden
        className="relative z-10 h-8 shrink-0"
      />

      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden px-[clamp(1rem,4vw,2.5rem)] pt-[clamp(2rem,6vh,5rem)] pb-[clamp(1rem,3vw,2rem)]">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
          {/* HERO */}
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

          {/* HOTKEY CARD */}
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
                    <HotkeyPreview />
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

          {/* STATS */}
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
