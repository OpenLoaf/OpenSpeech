import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Plus, Settings2 } from "lucide-react";
import { cn } from "../lib/cn";
import { HotkeyPreviewStatic, type StaticHotkeyToken } from "./HotkeyPreviewStatic";

/**
 * src/components/HotkeyDictationCard.tsx 的 !showPanel 默认视图克隆。
 * className / DOM 结构完全保留；i18n / store / dialog 已剥离，由本地状态驱动 tab 切换。
 */
type HotkeyTab = "dictate" | "translate";

const TRANSLATE_LANGS = [
  { id: "en", label: "English" },
  { id: "zh", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Español" },
] as const;

const DICTATE_TOKENS: StaticHotkeyToken[] = [
  { kind: "mod", label: "Option", sideLabel: null },
  { kind: "main", label: "Space" },
];

const TRANSLATE_TOKENS: StaticHotkeyToken[] = [
  { kind: "mod", label: "Control", sideLabel: null },
  { kind: "main", label: "T" },
];

interface HotkeyDictationCardStaticProps {
  /** 模拟按下激活态 —— 让 Kbd 全部高亮 */
  recording?: boolean;
  bare?: boolean;
}

export function HotkeyDictationCardStatic({
  recording = false,
  bare = false,
}: HotkeyDictationCardStaticProps) {
  const [hotkeyTab, setHotkeyTab] = useState<HotkeyTab>("dictate");
  const [translateTargetLang, setTranslateTargetLang] =
    useState<(typeof TRANSLATE_LANGS)[number]["id"]>("en");
  const [translateOutputMode, setTranslateOutputMode] = useState<
    "bilingual" | "target_only"
  >("bilingual");
  const [aiRefineEnabled] = useState(true);
  const [segmentMode] = useState<"UTTERANCE" | "REALTIME">("UTTERANCE");

  // 自动循环切 tab 让首页有"活"的感觉
  useEffect(() => {
    const t = setInterval(() => {
      setHotkeyTab((tab) => (tab === "dictate" ? "translate" : "dictate"));
    }, 6000);
    return () => clearInterval(t);
  }, []);

  const isLive = recording;

  const tokens = hotkeyTab === "translate" ? TRANSLATE_TOKENS : DICTATE_TOKENS;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay: 0.03 }}
      className={cn("flex min-h-0 w-full flex-col", bare && "flex-1")}
    >
      <div className="mb-2 flex shrink-0 items-end justify-between md:mb-3">
        <h2 className="font-mono text-base font-bold uppercase tracking-tighter text-te-fg md:text-lg">
          {hotkeyTab === "dictate" ? "听写快捷键" : "翻译快捷键"}
        </h2>
        <div
          className="flex shrink-0 border border-te-gray/60 bg-te-surface font-mono text-[10px] uppercase tracking-widest"
          role="tablist"
        >
          {(["translate", "dictate"] as const).map((tab) => {
            const active = hotkeyTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setHotkeyTab(tab)}
                className={
                  active
                    ? "px-2.5 py-1 bg-te-accent text-te-bg"
                    : "px-2.5 py-1 text-te-light-gray hover:text-te-fg"
                }
              >
                {tab === "dictate" ? "听写" : "翻译"}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5 md:mb-3">
        {hotkeyTab === "translate" ? (
          <>
            <div className="relative inline-flex items-center border border-te-gray/60 bg-te-surface transition-colors hover:border-te-accent focus-within:border-te-accent">
              <select
                value={translateTargetLang}
                onChange={(e) =>
                  setTranslateTargetLang(
                    e.target.value as (typeof TRANSLATE_LANGS)[number]["id"],
                  )
                }
                aria-label="目标语言"
                className="cursor-pointer appearance-none bg-transparent py-0.5 pr-6 pl-2 font-mono text-[10px] uppercase tracking-widest text-te-fg focus:outline-none md:text-xs"
              >
                {TRANSLATE_LANGS.map((lang) => (
                  <option key={lang.id} value={lang.id}>
                    {lang.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-te-light-gray" />
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={translateOutputMode === "bilingual"}
              aria-label="双语显示"
              onClick={() =>
                setTranslateOutputMode(
                  translateOutputMode === "bilingual"
                    ? "target_only"
                    : "bilingual",
                )
              }
              className={cn(
                "border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors md:text-xs",
                translateOutputMode === "bilingual"
                  ? "border-te-accent bg-te-accent text-te-bg"
                  : "border-te-gray/60 text-te-light-gray hover:border-te-accent hover:text-te-accent",
              )}
            >
              双语
            </button>
          </>
        ) : (
          <>
            <span className="border border-te-gray/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
              {segmentMode === "UTTERANCE" ? "整句模式" : "实时分段"}
            </span>
            <span className="border border-te-gray/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
              {aiRefineEnabled ? "AI 已开" : "AI 未开"}
            </span>
          </>
        )}
      </div>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden transition-colors",
          bare
            ? "p-3"
            : cn(
                "border bg-te-surface p-4 md:p-5",
                isLive ? "border-te-accent/80" : "border-te-gray/60",
              ),
        )}
      >
        <motion.div
          key={hotkeyTab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <HotkeyPreviewStatic
            fillHeight
            allHighlighted={recording}
            groups={[{ id: hotkeyTab, tokens }]}
            trailing={
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label="新增词典词条"
                  title="新增词典词条"
                  className="inline-flex size-8 items-center justify-center border border-te-gray/60 bg-te-surface text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent focus:outline-none focus-visible:border-te-accent"
                >
                  <Plus className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="编辑快捷键"
                  title="编辑快捷键"
                  className="inline-flex size-8 items-center justify-center border border-te-gray/60 bg-te-surface text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent focus:outline-none focus-visible:border-te-accent"
                >
                  <Settings2 className="size-4" aria-hidden />
                </button>
              </div>
            }
          />
          <p className="mt-3 max-w-2xl shrink-0 font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
            {hotkeyTab === "translate" ? (
              <>
                按住快捷键说话，松开后自动翻译并粘贴到当前应用；
                <span className="mx-1 font-mono text-te-fg">ESC</span>
                双击放弃。
              </>
            ) : (
              <>
                按住快捷键即开始录音，松开自动写入当前光标位置；
                <span className="mx-1 font-mono text-te-fg">ESC</span>
                双击放弃。
              </>
            )}
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}
