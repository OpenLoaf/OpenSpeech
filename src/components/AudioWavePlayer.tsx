// 复用：history 详情 dialog 与会议 review 都用同一个真实波形播放器（wavesurfer.js）。
//
// 用 Tauri invoke 把录音字节读到内存做成 blob URL 喂给 wavesurfer——webview
// 拿不到本地文件路径，必须绕道 invoke。
//
// 父组件可通过 ref 调 `seekToSec()` 让 segment 点击触发跳转；通过
// onTimeUpdate 拿 currentTime 做 segment 高亮同步。

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useWavesurfer } from "@wavesurfer/react";
import { Loader2, Pause, Play } from "lucide-react";

import { loadRecordingBytes } from "@/lib/audio";
import { usePlaybackStore } from "@/stores/playback";

function formatClockTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface AudioWavePlayerHandle {
  seekToSec: (sec: number) => void;
}

interface Props {
  audioPath: string;
  fallbackDurationMs: number;
  onTimeUpdate?: (currentSec: number) => void;
  height?: number;
}

export const AudioWavePlayer = forwardRef<AudioWavePlayerHandle, Props>(
  function AudioWavePlayer({ audioPath, fallbackDurationMs, onTimeUpdate, height = 56 }, ref) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    const [loadError, setLoadError] = useState(false);

    useEffect(() => {
      let cancelled = false;
      let url: string | null = null;
      setLoadError(false);
      setBlobUrl(null);
      (async () => {
        try {
          const buf = await loadRecordingBytes(audioPath);
          if (cancelled) return;
          const mime = audioPath.toLowerCase().endsWith(".ogg")
            ? "audio/ogg"
            : "audio/wav";
          url = URL.createObjectURL(new Blob([buf], { type: mime }));
          if (!cancelled) setBlobUrl(url);
        } catch (e) {
          console.error("[wavesurfer] load failed:", e);
          if (!cancelled) setLoadError(true);
        }
      })();
      return () => {
        cancelled = true;
        if (url) URL.revokeObjectURL(url);
      };
    }, [audioPath]);

    const { wavesurfer, isReady, isPlaying, currentTime } = useWavesurfer({
      container: containerRef,
      url: blobUrl ?? undefined,
      height,
      waveColor: "#6b6b6b",
      progressColor: "#FFB200",
      cursorColor: "#FFB200",
      cursorWidth: 1,
      barWidth: 2,
      barGap: 2,
      barRadius: 1,
      normalize: true,
      interact: true,
      dragToSeek: true,
    });

    useImperativeHandle(
      ref,
      () => ({
        seekToSec(sec) {
          if (!wavesurfer) return;
          const dur = wavesurfer.getDuration();
          if (dur <= 0) return;
          const ratio = Math.max(0, Math.min(1, sec / dur));
          wavesurfer.seekTo(ratio);
        },
      }),
      [wavesurfer],
    );

    // 全局回放（usePlaybackStore 的 HTML5 audio）和 wavesurfer 不能同时响——
    // dialog / review 起播时把全局先停。
    useEffect(() => {
      if (isPlaying) usePlaybackStore.getState().stop();
    }, [isPlaying]);

    useEffect(() => {
      onTimeUpdate?.(currentTime);
    }, [currentTime, onTimeUpdate]);

    const onPlayPause = useCallback(() => {
      if (wavesurfer) void wavesurfer.playPause();
    }, [wavesurfer]);

    const fallbackSec = Math.max(0, fallbackDurationMs / 1000);
    const duration = isReady && wavesurfer ? wavesurfer.getDuration() : fallbackSec;
    const showPause = isPlaying;

    return (
      <div className="flex shrink-0 items-center gap-3 border-t border-te-gray/40 bg-te-bg px-4 pt-5 pb-3">
        <span className="w-10 font-mono text-[11px] tabular-nums text-te-light-gray">
          {formatClockTime(currentTime)}
        </span>

        <div className="relative min-w-0 flex-1">
          <div ref={containerRef} className="w-full" />
          {!isReady && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-widest text-te-light-gray/60">
              {loadError ? "// load failed //" : "// loading //"}
            </div>
          )}
        </div>

        <span className="w-10 text-right font-mono text-[11px] tabular-nums text-te-light-gray">
          {formatClockTime(duration)}
        </span>

        <button
          type="button"
          onClick={onPlayPause}
          disabled={!isReady}
          className="inline-flex h-9 shrink-0 items-center gap-2 border border-te-gray/50 px-3 font-mono text-[11px] uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-te-gray/50 disabled:hover:text-te-fg"
          title={
            showPause ? t("pages:history.player.pause") : t("pages:history.player.play")
          }
          aria-label={
            showPause ? t("pages:history.player.pause") : t("pages:history.player.play")
          }
        >
          {!blobUrl && !loadError ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2.5} />
          ) : showPause ? (
            <Pause className="size-3.5" strokeWidth={2.5} />
          ) : (
            <Play className="size-3.5" strokeWidth={2.5} />
          )}
          <span>
            {showPause ? t("pages:history.player.pause") : t("pages:history.player.play")}
          </span>
        </button>
      </div>
    );
  },
);
