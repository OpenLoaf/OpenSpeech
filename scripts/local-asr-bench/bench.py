# /// script
# requires-python = ">=3.10"
# dependencies = ["sherpa-onnx>=1.13.8", "numpy", "psutil"]
# ///
"""本地 ASR 选型评测：用本机真实听写录音对比 sherpa-onnx 各模型与云端结果。

参考文本是云端 ASR 的原始输出（history.text），所以 CER 衡量的是「与当前云端的一致度」，
不是绝对准确率；分歧样本需要人工抽查才能判断谁对。

用法：
  uv run scripts/local-asr-bench/bench.py sample --n 150 --out set.jsonl
  uv run scripts/local-asr-bench/bench.py run --model sensevoice --models-dir <dir> --set set.jsonl --out sv.jsonl
  uv run scripts/local-asr-bench/bench.py report sv.jsonl qwen3.jsonl ...
"""

import argparse
import glob
import json
import os
import platform
import random
import sqlite3
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000


def app_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/com.openspeech.app"
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / "com.openspeech.app"
    return Path.home() / ".local/share/com.openspeech.app"


# 按时长分三层均匀抽样：短句 / 中段 / 长段，覆盖听写的真实分布
BUCKETS = [(1_000, 8_000), (8_000, 30_000), (30_000, 60_000)]


def cmd_sample(args):
    root = app_data_dir()
    db = sqlite3.connect(f"file:{root / 'openspeech.db'}?mode=ro", uri=True)
    rng = random.Random(args.seed)
    per = args.n // len(BUCKETS)
    rows = []
    for lo, hi in BUCKETS:
        cand = db.execute(
            "select id, audio_path, duration_ms, asr_ms, text from history "
            "where type='dictation' and status='success' and provider_kind='saas-file' "
            "and audio_path like '%.ogg' and duration_ms >= ? and duration_ms < ? "
            "and length(text) > 0",
            (lo, hi),
        ).fetchall()
        cand = [c for c in cand if (root / c[1]).exists()]
        for c in rng.sample(cand, min(per, len(cand))):
            rows.append(
                {"id": c[0], "audio": str(root / c[1]), "duration_ms": c[2], "cloud_ms": c[3], "ref": c[4]}
            )
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"sampled {len(rows)} -> {args.out}")


def load_audio(path: str) -> np.ndarray:
    # 统一走 ffmpeg 解码重采样，避免依赖 libsndfile 对 ogg/vorbis 的支持差异
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(pcm, dtype=np.float32)


def find(d: str, pattern: str) -> str:
    hits = sorted(glob.glob(os.path.join(d, pattern)))
    if not hits:
        raise FileNotFoundError(f"{pattern} not found in {d}")
    return hits[0]


def build_recognizer(name: str, models_dir: str, threads: int):
    import sherpa_onnx as so

    if name == "sensevoice":
        d = find(models_dir, "sherpa-onnx-sense-voice-*int8-2025-09-09")
        return so.OfflineRecognizer.from_sense_voice(
            model=find(d, "model*.onnx"), tokens=find(d, "tokens.txt"), num_threads=threads, use_itn=True
        )
    if name == "qwen3":
        d = find(models_dir, "sherpa-onnx-qwen3-asr-0.6B-int8-*")
        return so.OfflineRecognizer.from_qwen3_asr(
            conv_frontend=find(d, "conv_frontend*.onnx"),
            encoder=find(d, "encoder*.onnx"),
            decoder=find(d, "decoder*.onnx"),
            tokenizer=find(d, "tokenizer*"),
            num_threads=threads,
            # 60 秒音频的 audio token 加文本要留足余量，默认 512 会截断长句
            max_total_len=2048,
            max_new_tokens=512,
        )
    if name == "funasr-nano":
        d = find(models_dir, "sherpa-onnx-funasr-nano-int8-*")
        return so.OfflineRecognizer.from_funasr_nano(
            encoder_adaptor=find(d, "encoder_adaptor*.onnx"),
            llm=find(d, "llm*.onnx"),
            embedding=find(d, "embedding*.onnx"),
            tokenizer=find(d, "Qwen3*"),
            num_threads=threads,
            itn=True,
        )
    if name == "firered-ctc":
        d = find(models_dir, "sherpa-onnx-fire-red-asr2-ctc-*")
        return so.OfflineRecognizer.from_fire_red_asr_ctc(
            model=find(d, "model*.onnx"), tokens=find(d, "tokens.txt"), num_threads=threads
        )
    if name == "firered-aed":
        d = find(models_dir, "sherpa-onnx-fire-red-asr2-zh_en-*")
        return so.OfflineRecognizer.from_fire_red_asr(
            encoder=find(d, "encoder*.onnx"), decoder=find(d, "decoder*.onnx"), tokens=find(d, "tokens.txt"),
            num_threads=threads,
        )
    if name == "xasr-stream":
        d = find(models_dir, "sherpa-onnx-x-asr-160ms-streaming-*punct*")
        return so.OnlineRecognizer.from_transducer(
            tokens=find(d, "tokens.txt"), encoder=find(d, "encoder*.onnx"), decoder=find(d, "decoder*.onnx"),
            joiner=find(d, "joiner*.onnx"), num_threads=threads,
        )
    raise ValueError(name)


STREAMING_MODELS = {"xasr-stream"}
CHUNK = SAMPLE_RATE * 160 // 1000


def decode_offline(rec, audio):
    s = rec.create_stream()
    s.accept_waveform(SAMPLE_RATE, audio)
    t = time.perf_counter()
    rec.decode_stream(s)
    ms = (time.perf_counter() - t) * 1000
    return s.result.text, ms, ms


def decode_streaming(rec, audio):
    # 模拟实时：按 160ms 块喂入并尽量解码；total 是总计算量，tail 是松键（input_finished）后还要等多久
    s = rec.create_stream()
    total = 0.0
    for k in range(0, len(audio), CHUNK):
        s.accept_waveform(SAMPLE_RATE, audio[k:k + CHUNK])
        t = time.perf_counter()
        while rec.is_ready(s):
            rec.decode_stream(s)
        total += (time.perf_counter() - t) * 1000
    # 尾部补 0.5s 静音，让模型把最后几个字吐干净
    s.accept_waveform(SAMPLE_RATE, np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    s.input_finished()
    t = time.perf_counter()
    while rec.is_ready(s):
        rec.decode_stream(s)
    tail = (time.perf_counter() - t) * 1000
    return rec.get_result(s), total + tail, tail


def peak_rss_mb() -> float:
    # 取进程生命周期内的真实峰值：1GB 是硬门槛，不能用结束时的 RSS 低估
    if sys.platform == "win32":
        import psutil

        return psutil.Process().memory_info().peak_wset / 1048576
    import resource

    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS 单位是字节，Linux 是 KB
    return r / 1048576 if sys.platform == "darwin" else r / 1024


def cmd_run(args):
    rows = [json.loads(l) for l in open(args.set, encoding="utf-8")]
    t0 = time.perf_counter()
    rec = build_recognizer(args.model, args.models_dir, args.threads)
    load_ms = (time.perf_counter() - t0) * 1000
    loaded_rss = peak_rss_mb()
    decode = decode_streaming if args.model in STREAMING_MODELS else decode_offline
    if args.vad and args.model in STREAMING_MODELS:
        raise SystemExit("streaming models do their own endpointing; --vad is not applicable")
    # 预热一次，排除首次推理的图优化开销
    decode(rec, np.zeros(SAMPLE_RATE, dtype=np.float32))

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(json.dumps({"meta": {"model": args.model, "threads": args.threads, "load_ms": load_ms,
                                     "vad": bool(args.vad), "loaded_rss_mb": loaded_rss,
                                     "machine": platform.platform(), "cpu": platform.processor()}}) + "\n")
        for i, r in enumerate(rows):
            audio = load_audio(r["audio"])
            segments = vad_split(audio, args.vad) if args.vad else [audio]
            texts, costs = [], []
            tails = []
            for seg in segments:
                text, cost, tail = decode(rec, seg)
                costs.append(cost)
                tails.append(tail)
                texts.append(text)
            ms = sum(costs)
            # tail_ms：流水线模式下用户松键后只需等最后一段的解码
            out = {**r, "hyp": "".join(texts), "local_ms": ms, "tail_ms": tails[-1] if tails else 0.0,
                   "segments": len(segments)}
            f.write(json.dumps(out, ensure_ascii=False) + "\n")
            print(f"[{i + 1}/{len(rows)}] {r['duration_ms'] / 1000:.1f}s -> {ms:.0f}ms", flush=True)
        f.write(json.dumps({"meta_end": {"peak_rss_mb": peak_rss_mb()}}) + "\n")


def vad_split(audio: np.ndarray, vad_model: str) -> list:
    import sherpa_onnx as so

    # 与产品形态一致：静音 0.5s 断句，单段上限 20s（Fun-ASR-Nano 超过约 20s 会输出空）
    cfg = so.VadModelConfig(
        silero_vad=so.SileroVadModelConfig(model=vad_model, min_silence_duration=0.5, max_speech_duration=20),
        sample_rate=SAMPLE_RATE,
    )
    vad = so.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)
    win = cfg.silero_vad.window_size
    segs = []
    for k in range(0, len(audio), win):
        vad.accept_waveform(audio[k:k + win])
        while not vad.empty():
            segs.append(np.array(vad.front.samples, dtype=np.float32))
            vad.pop()
    vad.flush()
    while not vad.empty():
        segs.append(np.array(vad.front.samples, dtype=np.float32))
        vad.pop()
    return segs


def normalize(t: str) -> str:
    # 去标点、空白、符号，统一全半角与大小写，只比对实际字符
    t = unicodedata.normalize("NFKC", t).lower()
    return "".join(c for c in t if not unicodedata.category(c)[0] in "PSZC")


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def pct(xs, p):
    return float(np.percentile(xs, p)) if xs else float("nan")


def cmd_report(args):
    for path in args.files:
        lines = [json.loads(l) for l in open(path, encoding="utf-8")]
        meta = lines[0]["meta"]
        end = lines[-1].get("meta_end", {})
        rows = [l for l in lines if "hyp" in l]
        print(f"\n== {meta['model']}{' +vad' if meta.get('vad') else ''} (threads={meta['threads']}, load={meta['load_ms']:.0f}ms, "
              f"loaded_rss={meta.get('loaded_rss_mb', float('nan')):.0f}MB, "
              f"peak_rss={end.get('peak_rss_mb', float('nan')):.0f}MB) n={len(rows)}")
        print(f"{'bucket':<10}{'n':>4}{'CER':>8}{'local p50':>11}{'local p90':>11}{'tail p50':>10}{'cloud p50':>11}{'RTF':>7}")
        for lo, hi in BUCKETS + [(0, 10**9)]:
            b = [r for r in rows if lo <= r["duration_ms"] < hi]
            if not b:
                continue
            errs = sum(edit_distance(normalize(r["ref"]), normalize(r["hyp"])) for r in b)
            chars = sum(len(normalize(r["ref"])) for r in b)
            loc = [r["local_ms"] for r in b]
            tail = [r.get("tail_ms", r["local_ms"]) for r in b]
            cloud = [r["cloud_ms"] for r in b if r.get("cloud_ms")]
            rtf = sum(loc) / sum(r["duration_ms"] for r in b)
            label = "all" if hi == 10**9 else f"{lo // 1000}-{hi // 1000}s"
            print(f"{label:<10}{len(b):>4}{errs / chars:>8.2%}{pct(loc, 50):>9.0f}ms{pct(loc, 90):>9.0f}ms"
                  f"{pct(tail, 50):>8.0f}ms{pct(cloud, 50):>9.0f}ms{rtf:>7.3f}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--n", type=int, default=150)
    s.add_argument("--seed", type=int, default=42)
    s.add_argument("--out", required=True)
    r = sub.add_parser("run")
    r.add_argument("--model", choices=["sensevoice", "qwen3", "funasr-nano", "firered-ctc", "firered-aed", "xasr-stream"], required=True)
    r.add_argument("--models-dir", required=True)
    r.add_argument("--set", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--threads", type=int, default=4)
    r.add_argument("--vad", help="silero_vad.onnx 路径；给了就先 VAD 切段再逐段识别")
    rp = sub.add_parser("report")
    rp.add_argument("files", nargs="+")
    a = p.parse_args()
    {"sample": cmd_sample, "run": cmd_run, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
