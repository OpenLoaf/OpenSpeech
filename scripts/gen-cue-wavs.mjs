// 离线渲染听写提示音 WAV，参数与原 src/stores/recording.ts 中 ding() 一致：
// 两个 sine partial（基频 + 二次谐波）→ RBJ biquad lowpass（cutoff = freq*2.2, Q=0.4）
// → 30ms linear attack + exponential decay 到 0.0001。
// 输出 mono 16-bit PCM @ 48kHz，嵌入 src-tauri 二进制。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../src-tauri/resources/cues");
mkdirSync(OUT_DIR, { recursive: true });

function biquadLowpass(input, freq, Q) {
  const w = (2 * Math.PI * freq) / SR;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const alpha = sinW / (2 * Q);
  const b0 = (1 - cosW) / 2;
  const b1 = 1 - cosW;
  const b2 = (1 - cosW) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  const out = new Float64Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function envelope(t, durSec, peak) {
  if (t < 0) return 0;
  if (t < 0.03) return peak * (t / 0.03);
  if (t < durSec) {
    const T = durSec - 0.03;
    const u = (t - 0.03) / T;
    return peak * Math.exp(u * Math.log(0.0001 / peak));
  }
  return 0;
}

function synthDing(freq, durationMs, delayMs, peakGain) {
  const partials = [
    { ratio: 1, gain: 1 },
    { ratio: 2, gain: 0.18 },
  ];
  const durSec = durationMs / 1000;
  const totalSec = (delayMs + durationMs + 80) / 1000;
  const total = Math.ceil(totalSec * SR);
  const out = new Float64Array(total);
  const startSample = Math.round((delayMs / 1000) * SR);
  for (const p of partials) {
    const partialBuf = new Float64Array(total);
    const oscFreq = freq * p.ratio;
    const partialPeak = peakGain * p.gain;
    let phase = 0;
    const dPhase = (2 * Math.PI * oscFreq) / SR;
    for (let i = 0; i < total; i++) {
      const t = (i - startSample) / SR;
      if (t < 0) {
        phase += dPhase;
        continue;
      }
      const env = envelope(t, durSec, partialPeak);
      partialBuf[i] = Math.sin(phase) * env;
      phase += dPhase;
    }
    const filtered = biquadLowpass(partialBuf, freq * 2.2, 0.4);
    for (let i = 0; i < total; i++) out[i] += filtered[i];
  }
  return out;
}

function mix(dings) {
  const totalSec = Math.max(
    ...dings.map((d) => (d.delayMs + d.durationMs + 80) / 1000),
  );
  const total = Math.ceil(totalSec * SR);
  const out = new Float64Array(total);
  for (const d of dings) {
    const buf = synthDing(
      d.freq,
      d.durationMs,
      d.delayMs ?? 0,
      d.peakGain ?? 0.09,
    );
    for (let i = 0; i < buf.length && i < total; i++) out[i] += buf[i];
  }
  return out;
}

function writeWav(path, samples) {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    int16[i] = Math.round(v * 32767);
  }
  const dataSize = int16.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < int16.length; i++)
    buf.writeInt16LE(int16[i], 44 + i * 2);
  writeFileSync(path, buf);
  return buf.length;
}

const cues = {
  start: [
    { freq: 440, durationMs: 280, delayMs: 0 },
    { freq: 659.25, durationMs: 420, delayMs: 160 },
  ],
  stop: [{ freq: 523.25, durationMs: 460, delayMs: 0 }],
  cancel: [
    { freq: 659.25, durationMs: 260, delayMs: 0 },
    { freq: 440, durationMs: 460, delayMs: 160 },
  ],
};

for (const [name, dings] of Object.entries(cues)) {
  const samples = mix(dings);
  const path = resolve(OUT_DIR, `${name}.wav`);
  const size = writeWav(path, samples);
  console.log(`wrote ${path} (${size} bytes, ${samples.length} samples)`);
}
