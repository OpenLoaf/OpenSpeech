// 系统声音 × 麦克风混音，平台无关，可单测。
//
// 时钟模型：麦克风是主时钟。会议链路原本就由麦克风 callback 驱动（每 ~10ms 一帧
// PCM16 送进 meetings），混音只是在送出前把同等长度的系统声音叠上去。系统声音由
// 另一条采集线程异步写入 ring，两边时钟不同源，所以：
//
//   - ring 欠载（系统声音还没到 / Windows loopback 无声时根本不回调）→ 补零，
//     并重新攒够 PRIME 才继续取，避免碎片化的「有一下没一下」。
//   - 两边速率有偏差（不同设备晶振、麦克风路径的无状态重采样每块丢 0~1 个采样）→
//     按 ring 水位微调读取步长（±1% 内，音高变化人耳和 ASR 都无感），让水位稳定在
//     TARGET 附近，不靠周期性丢一大段来追。
//   - 麦克风流卡顿 / 重启导致积压超过 MAX → 直接丢到 TARGET（这段本来也已经过时了）。
//
// 外放回声：用外放开会时麦克风会再收一遍对方的声音，混音后同一句出现两份（相差
// 几十毫秒）。系统声音有能量时把麦克风压低 DUCKED_MIC_GAIN，静下来 HOLD 后再恢复。
// 戴耳机时这会让双讲期间自己的声音小一点，可接受。

use std::collections::VecDeque;

/// 会议链路固定 16k 单声道。
pub(crate) const SAMPLE_RATE: u32 = 16_000;
const MS: usize = (SAMPLE_RATE / 1000) as usize;

/// 欠载后需要重新攒够这么多才开始取（抗采集线程抖动）。
const PRIME: usize = 40 * MS;
/// 水位目标：稳定后系统声音相对麦克风的延迟大致就是这么多。
const TARGET: usize = 80 * MS;
/// 积压上限，超过直接丢到 TARGET。
const MAX: usize = 500 * MS;
/// 读取步长最大偏移量（相对 1.0）。
const MAX_STEP_SKEW: f64 = 0.01;

/// 系统声音 RMS 超过它视为「对方在说话」（约 -40 dBFS）。
const DUCK_THRESHOLD: f32 = 0.01;
const DUCKED_MIC_GAIN: f32 = 0.5;
/// 系统声音静下来后保持压低多久再恢复，避免词间停顿里麦克风忽大忽小。
const DUCK_HOLD_SAMPLES: usize = 300 * MS;
/// 增益每采样最大变化量：约 50ms 从 1.0 过渡到 0.5，避免咔哒声。
const GAIN_STEP: f32 = 0.5 / (50 * MS) as f32;

/// 跨 chunk 连续的线性插值重采样器，给系统声音用。
///
/// 与 `audio::push_to_stt_pcm16` 的无状态版本不同，这里记住上一块的末尾采样和
/// 小数相位，块边界不丢采样，长时间运行不会产生累计速率偏差。
pub(crate) struct StreamResampler {
    /// 每个输出采样前进多少个输入采样。
    step: f64,
    /// 下一个输出采样在当前输入块坐标系中的位置；-1 表示上一块的最后一个采样。
    pos: f64,
    prev: f32,
}

impl StreamResampler {
    pub(crate) fn new(src_rate: u32) -> Self {
        Self {
            step: src_rate.max(1) as f64 / SAMPLE_RATE as f64,
            pos: 0.0,
            prev: 0.0,
        }
    }

    pub(crate) fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let n = input.len() as f64;
        let at = |i: isize| -> f32 { if i < 0 { self.prev } else { input[i as usize] } };
        // pos < n-1 保证 lo+1 仍在本块内；剩下的留到下一块（借 prev 插值）。
        while self.pos < n - 1.0 {
            let lo = self.pos.floor();
            let frac = (self.pos - lo) as f32;
            let lo = lo as isize;
            out.push(at(lo) * (1.0 - frac) + at(lo + 1) * frac);
            self.pos += self.step;
        }
        self.pos -= n;
        self.prev = input[input.len() - 1];
    }
}

pub(crate) struct Mixer {
    ring: VecDeque<f32>,
    /// ring 头部之后的小数读取位置（0 <= read_frac < 1）。
    read_frac: f64,
    primed: bool,
    mic_gain: f32,
    duck_hold: usize,
}

impl Default for Mixer {
    fn default() -> Self {
        Self::new()
    }
}

impl Mixer {
    pub(crate) fn new() -> Self {
        Self {
            ring: VecDeque::with_capacity(MAX + 4096),
            read_frac: 0.0,
            primed: false,
            mic_gain: 1.0,
            duck_hold: 0,
        }
    }

    /// 采集线程写入 16k 单声道系统声音。
    pub(crate) fn push_system(&mut self, samples: &[f32]) {
        self.ring.extend(samples.iter().copied());
        if self.ring.len() > MAX {
            let drop = self.ring.len() - TARGET;
            self.ring.drain(..drop);
            self.read_frac = 0.0;
        }
    }

    /// 把系统声音叠进一帧麦克风 PCM16 LE（原地修改）。
    pub(crate) fn mix_into_pcm16(&mut self, pcm16: &mut [u8]) {
        let n = pcm16.len() / 2;
        if n == 0 {
            return;
        }
        let sys = self.take_system(n);

        let rms = (sys.iter().map(|s| s * s).sum::<f32>() / n as f32).sqrt();
        if rms > DUCK_THRESHOLD {
            self.duck_hold = DUCK_HOLD_SAMPLES;
        } else {
            self.duck_hold = self.duck_hold.saturating_sub(n);
        }
        let target_gain = if self.duck_hold > 0 {
            DUCKED_MIC_GAIN
        } else {
            1.0
        };

        for (i, s) in sys.iter().enumerate() {
            let b = &mut pcm16[i * 2..i * 2 + 2];
            let mic = i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32;
            if self.mic_gain < target_gain {
                self.mic_gain = (self.mic_gain + GAIN_STEP).min(target_gain);
            } else if self.mic_gain > target_gain {
                self.mic_gain = (self.mic_gain - GAIN_STEP).max(target_gain);
            }
            let v = (mic * self.mic_gain + s).clamp(-1.0, 1.0);
            b.copy_from_slice(&((v * i16::MAX as f32) as i16).to_le_bytes());
        }
    }

    /// 取出 n 个对齐到麦克风时钟的系统声音采样；不够的部分为 0。
    fn take_system(&mut self, n: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; n];
        if !self.primed {
            if self.ring.len() < PRIME {
                return out;
            }
            self.primed = true;
        }

        // 水位高于 TARGET 就读快一点，低于就读慢一点。
        let level = self.ring.len() as f64;
        let skew = ((level - TARGET as f64) / TARGET as f64 * MAX_STEP_SKEW)
            .clamp(-MAX_STEP_SKEW, MAX_STEP_SKEW);
        let step = 1.0 + skew;

        let mut pos = self.read_frac;
        for o in out.iter_mut() {
            let lo = pos.floor() as usize;
            if lo + 1 >= self.ring.len() {
                // 欠载：剩下的补零，等下次重新攒够 PRIME。
                self.primed = false;
                break;
            }
            let frac = (pos - lo as f64) as f32;
            *o = self.ring[lo] * (1.0 - frac) + self.ring[lo + 1] * frac;
            pos += step;
        }
        let consumed = (pos.floor() as usize).min(self.ring.len());
        self.ring.drain(..consumed);
        self.read_frac = if self.primed { pos - pos.floor() } else { 0.0 };
        out
    }

    #[cfg(test)]
    fn buffered(&self) -> usize {
        self.ring.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm16(samples: &[f32]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|s| ((s * i16::MAX as f32) as i16).to_le_bytes())
            .collect()
    }

    fn decode(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
            .collect()
    }

    // 48k → 16k 分很多小块喂进去，总输出长度必须等于一次性处理的长度：
    // 块边界不能丢采样，否则长会议里系统声音会被慢慢「吃掉」。
    #[test]
    fn resampler_does_not_lose_samples_across_chunks() {
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut chunked = StreamResampler::new(48_000);
        let mut out = Vec::new();
        for c in input.chunks(437) {
            chunked.process(c, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 1, "got {}", out.len());
    }

    // 还没攒够系统声音时，麦克风原样通过（不能被静音或篡改）。
    #[test]
    fn mic_passes_through_before_system_audio_arrives() {
        let mut m = Mixer::new();
        let mic = vec![0.25f32; 160];
        let mut frame = pcm16(&mic);
        m.mix_into_pcm16(&mut frame);
        for v in decode(&frame) {
            assert!((v - 0.25).abs() < 1e-3);
        }
    }

    // 攒够后系统声音被叠加进来——这正是「本机开会录不到对方」要修的事。
    #[test]
    fn system_audio_is_mixed_in_once_primed() {
        let mut m = Mixer::new();
        m.push_system(&vec![0.2f32; PRIME + 320]);
        let mut frame = pcm16(&vec![0.0f32; 160]);
        m.mix_into_pcm16(&mut frame);
        let out = decode(&frame);
        assert!(out.iter().all(|v| (v - 0.2).abs() < 1e-2));
    }

    // 系统声音有能量时麦克风被压低，防止外放回声把同一句录成两份。
    #[test]
    fn mic_is_ducked_while_system_audio_is_loud() {
        let mut m = Mixer::new();
        m.push_system(&vec![0.0f32; PRIME]);
        // 先消耗掉静音前缀，再塞入响亮的系统声音
        let mut warm = pcm16(&vec![0.0f32; PRIME]);
        m.mix_into_pcm16(&mut warm);
        for _ in 0..20 {
            m.push_system(&vec![0.1f32; 160]);
            let mut f = pcm16(&vec![0.4f32; 160]);
            m.mix_into_pcm16(&mut f);
        }
        let mut frame = pcm16(&vec![0.4f32; 160]);
        m.push_system(&vec![0.1f32; 160]);
        m.mix_into_pcm16(&mut frame);
        let last = *decode(&frame).last().unwrap();
        // 0.4 * 0.5 + 0.1
        assert!((last - 0.3).abs() < 2e-2, "got {last}");
    }

    // 生产快于消费（时钟偏差）时，水位应被拉回 TARGET 附近而不是无限增长。
    #[test]
    fn buffer_level_stays_bounded_under_clock_drift() {
        let mut m = Mixer::new();
        for _ in 0..3000 {
            // 系统端每 10ms 多给 0.5%（161 vs 160）
            m.push_system(&vec![0.01f32; 161]);
            let mut f = pcm16(&vec![0.0f32; 160]);
            m.mix_into_pcm16(&mut f);
        }
        assert!(m.buffered() < MAX, "buffered {}", m.buffered());
        assert!(m.buffered() > PRIME, "buffered {}", m.buffered());
    }
}
