import { memo, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

const BAR_COUNT = 20;
const BAR_MIN_H = 4;
const BAR_MAX_H = 26;
const BAR_WIDTH_PX = 4;
// Math.pow(x, CURVE_GAMMA) 替代 sqrt 拉低音量段的可见度。0.35 比 0.5 更陡，
// 普通说话音量（gated 后约 0.1~0.3）能直接吃到 50~70% 的高度。
const CURVE_GAMMA = 0.35;

// 50Hz 的 audio-level 高频更新如果走 zustand/useState 会触发整树 re-render。
// 用 useSyncExternalStore + 模块级 ring buffer：peak 只更新本地 Float32Array，
// 然后通知所有订阅者；React 只会重渲染 Waveform 子组件本身。
// snapshotCache：useSyncExternalStore 要求 getSnapshot 在数据未变时返回稳定引用——
// 缓存一个 Float32Array slice，更新到达后清缓存，下次 getSnapshot 重新切片。
class WaveStore {
  private buffer = new Float32Array(BAR_COUNT);
  private listeners = new Set<() => void>();
  private snapshotCache: Float32Array | null = null;
  private attached = false;

  ensureAttached() {
    if (this.attached) return;
    this.attached = true;
    void listen<number>("openspeech://audio-level", (e) => {
      const v = Math.max(0, Math.min(1, Number(e.payload) || 0));
      this.buffer.copyWithin(1, 0, BAR_COUNT - 1);
      this.buffer[0] = v;
      this.snapshotCache = null;
      this.listeners.forEach((l) => l());
    });
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = (): Float32Array => {
    if (this.snapshotCache === null) {
      this.snapshotCache = this.buffer.slice() as Float32Array;
    }
    return this.snapshotCache;
  };

  reset() {
    this.buffer.fill(0);
    this.snapshotCache = null;
    this.listeners.forEach((l) => l());
  }
}

const waveStore = new WaveStore();
waveStore.ensureAttached();

export function resetWaveform() {
  waveStore.reset();
}

// 始终按 ring buffer 当前值绘制——idle 时 buffer 已被 resetWaveform 清零，柱子
// 自动塌到最低高度。transform 走 GPU 合成层，避免 layout/paint。
// barCount 受调用方控制：翻译态下 pill 多塞了一个 LANG 徽章占走宽度，少画几根
// 柱子才能让 justify-between 的间距与原来一致；最大不超过 buffer 容量 BAR_COUNT。
export const Waveform = memo(function Waveform({
  barCount = BAR_COUNT,
}: { barCount?: number }) {
  const levels = useSyncExternalStore(waveStore.subscribe, waveStore.getSnapshot);
  const n = Math.max(1, Math.min(BAR_COUNT, barCount));
  return (
    <div className="flex h-full w-full items-center justify-between">
      {Array.from({ length: n }, (_, i) => {
        const lvl = Math.max(0, levels[i] ?? 0);
        const boosted = lvl > 0 ? Math.min(1, Math.pow(lvl, CURVE_GAMMA)) : 0;
        const ratio =
          (BAR_MIN_H + boosted * (BAR_MAX_H - BAR_MIN_H)) / BAR_MAX_H;
        return (
          <span
            key={i}
            className="inline-block origin-center bg-te-fg"
            style={{
              width: BAR_WIDTH_PX,
              height: BAR_MAX_H,
              transform: `scaleY(${ratio})`,
              transition: "transform 60ms ease-out",
              willChange: "transform",
            }}
          />
        );
      })}
    </div>
  );
});
