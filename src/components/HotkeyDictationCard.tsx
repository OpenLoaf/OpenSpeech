import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans } from "react-i18next";
import { HotkeyPreview } from "@/components/HotkeyPreview";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { cn } from "@/lib/utils";
import { useRecordingStore, type RecordingState } from "@/stores/recording";

export function HotkeyDictationCard({ bare = false }: { bare?: boolean } = {}) {
  const recState = useRecordingStore((s) => s.state);
  const audioLevels = useRecordingStore((s) => s.audioLevels);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const isLive = recState !== "idle";

  const [resultText, setResultText] = useState<string | null>(null);
  const lastTranscriptRef = useRef("");
  const prevStateRef = useRef<RecordingState>("idle");

  useEffect(() => {
    if (liveTranscript) lastTranscriptRef.current = liveTranscript;
  }, [liveTranscript]);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = recState;
    if (prev === "idle" && recState !== "idle") {
      setResultText(null);
      lastTranscriptRef.current = "";
      return;
    }
    if (prev !== "idle" && recState === "idle") {
      const captured = lastTranscriptRef.current.trim();
      setResultText(captured ? lastTranscriptRef.current : null);
    }
  }, [recState]);

  const showResult = !isLive && resultText !== null;
  const showPanel = isLive || showResult;
  const panelTranscript = isLive ? liveTranscript : (resultText ?? "");

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay: 0.03 }}
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden",
        bare
          ? "flex-1 p-3"
          : cn(
              "border bg-te-surface p-4 transition-colors md:p-5",
              isLive ? "border-te-accent/80" : "border-te-gray/60",
            ),
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {showPanel ? (
          <motion.div
            key="live"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <LiveDictationPanel
              state={recState}
              audioLevels={audioLevels}
              liveTranscript={panelTranscript}
              onClose={showResult ? () => setResultText(null) : undefined}
            />
          </motion.div>
        ) : (
          <motion.div
            key="preview"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <HotkeyPreview hintPlacement="header" fillHeight />
            <p className="mt-3 max-w-2xl shrink-0 font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
              <Trans
                i18nKey="pages:home.hotkey_hint"
                components={{
                  esc: <span className="mx-1 font-mono text-te-fg" />,
                }}
              />
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
