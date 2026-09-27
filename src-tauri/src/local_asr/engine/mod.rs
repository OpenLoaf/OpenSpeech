// 本地推理引擎抽象。
//
// 两层 trait：
// - LocalAsrEngine：已加载的模型（权重常驻内存，可跨会话复用，Send + Sync）；
// - LocalAsrStream：一次听写的解码状态（单线程独占）。
// 引擎只在推理子进程里实例化（见 local_asr/host），主进程不持有模型。新增引擎
// 类型只需在 catalog::EngineSpec 加变体 + 在 load() 里分派，不碰调用方。

mod sherpa_transducer;

use std::path::Path;
use std::sync::Arc;

use tauri::Runtime;

use super::catalog::{self, EngineSpec, ModelSpec};
use super::error::LocalAsrError;
use super::install;

/// 引擎吐给上层的增量结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamUpdate {
    /// 当前句的识别中间态（会被后续 Partial / Final 覆盖）。
    Partial(String),
    /// 当前句已定稿；之后的输出属于下一句。
    Final(String),
}

pub trait LocalAsrEngine: Send + Sync {
    fn model_id(&self) -> &str;
    fn open_stream(self: Arc<Self>) -> Box<dyn LocalAsrStream>;
}

pub trait LocalAsrStream: Send {
    /// 16kHz 单声道 f32（[-1, 1]）。
    fn accept(&mut self, samples: &[f32]);
    /// 音频已全部送完：冲刷尾部，之后 drain 会把剩余文本以 Final 吐出。
    fn finish(&mut self);
    /// 解码已就绪的帧，把增量结果追加到 out。
    fn drain(&mut self, out: &mut Vec<StreamUpdate>);
}

pub const SAMPLE_RATE: u32 = 16_000;

type SharedEngine = Arc<dyn LocalAsrEngine>;

/// 按 catalog 规格从已安装目录加载引擎。阻塞（X-ASR 约 1.5s），只在推理子进程里调。
pub fn load(
    spec: &'static ModelSpec,
    dir: &Path,
    threads: i32,
) -> Result<SharedEngine, LocalAsrError> {
    if !install::is_installed_at(dir, spec) {
        return Err(LocalAsrError::NotInstalled(spec.id.to_string()));
    }
    Ok(match spec.engine {
        EngineSpec::SherpaOnlineTransducer {
            encoder,
            decoder,
            joiner,
            tokens,
        } => Arc::new(sherpa_transducer::SherpaTransducerEngine::load(
            spec.id,
            &dir.join(encoder),
            &dir.join(decoder),
            &dir.join(joiner),
            &dir.join(tokens),
            threads,
        )?),
    })
}

/// 只校验「模型存在且已安装」，不加载。stt_start 用它同步快速失败（未安装要立刻
/// 引导去设置页），加载交给会话 worker，避免加载期间丢音频。
pub fn check_installed<R: Runtime>(
    app: &tauri::AppHandle<R>,
    model_id: &str,
) -> Result<(), LocalAsrError> {
    let spec =
        catalog::find(model_id).ok_or_else(|| LocalAsrError::UnknownModel(model_id.to_string()))?;
    if install::is_installed(app, spec) {
        Ok(())
    } else {
        Err(LocalAsrError::NotInstalled(model_id.to_string()))
    }
}

/// 推理线程数：半数逻辑核，夹在 [1, 4]。实测 4 线程之后收益递减，
/// 再多只会跟前台应用抢 CPU。
pub fn inference_threads() -> i32 {
    let n = std::thread::available_parallelism().map_or(2, |n| n.get());
    (n / 2).clamp(1, 4) as i32
}

/// 离线整段识别：把整段音频喂进流式引擎，拼接所有句子。真模型测试对照用。
#[cfg(test)]
fn transcribe_samples(engine: SharedEngine, samples: &[f32]) -> String {
    let mut stream = engine.open_stream();
    let mut updates = Vec::new();
    // 分块喂入，贴近实时路径的解码节奏，也避免一次性给 onnxruntime 过大的输入。
    for chunk in samples.chunks(SAMPLE_RATE as usize / 10) {
        stream.accept(chunk);
        stream.drain(&mut updates);
    }
    stream.finish();
    stream.drain(&mut updates);
    join_finals(&updates)
}

#[cfg(test)]
fn join_finals(updates: &[StreamUpdate]) -> String {
    updates
        .iter()
        .filter_map(|u| match u {
            StreamUpdate::Final(t) => Some(t.as_str()),
            StreamUpdate::Partial(_) => None,
        })
        .collect()
}

/// 模型原始输出的空白规整：中文标点后、中文字符之间的空格去掉，中英之间保留一个。
/// X-ASR 会在「，」之后吐一个空格（`命令， 那我`），直接注入输入框很扎眼。
pub fn tidy_text(raw: &str) -> String {
    let chars: Vec<char> = raw.trim().chars().collect();
    let mut out = String::with_capacity(raw.len());
    for (i, &c) in chars.iter().enumerate() {
        if c.is_whitespace() {
            let prev = out.chars().last();
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace()).copied();
            let (Some(p), Some(n)) = (prev, next) else {
                continue;
            };
            if p.is_whitespace() {
                continue;
            }
            // 贴着中文标点、或两侧都是汉字：去掉；中英混排（一侧半角）保留一个空格。
            if is_cjk_punct(p) || is_cjk_punct(n) || (is_wide(p) && is_wide(n)) {
                continue;
            }
            out.push(' ');
            continue;
        }
        out.push(c);
    }
    out
}

fn is_wide(c: char) -> bool {
    // 0x2E80..=0x9FFF 已含 CJK 符号标点（0x3000..=0x303F）。
    matches!(c as u32, 0x2E80..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

fn is_cjk_punct(c: char) -> bool {
    matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFFEF)
}

#[cfg(test)]
mod tests {
    use super::*;

    // X-ASR 实测输出样本：中文标点后多吐空格，中英之间有空格。
    #[test]
    fn tidy_removes_space_after_cjk_punct_keeps_latin_gaps() {
        assert_eq!(
            tidy_text("比如说我 runner 启动的是一个 bash 的命令， 那我正常 exit 以后"),
            "比如说我 runner 启动的是一个 bash 的命令，那我正常 exit 以后"
        );
        assert_eq!(tidy_text("  你好  世界 "), "你好世界");
        assert_eq!(tidy_text("mod bus  server"), "mod bus server");
    }

    #[test]
    fn join_keeps_only_finals_in_order() {
        let u = vec![
            StreamUpdate::Partial("你".into()),
            StreamUpdate::Final("你好。".into()),
            StreamUpdate::Partial("世".into()),
            StreamUpdate::Final("世界。".into()),
        ];
        assert_eq!(join_finals(&u), "你好。世界。");
    }

    /// 真模型端到端（手动跑）：整段识别 vs 走子进程协议的流式识别，结果必须一致。
    ///   OPENSPEECH_LOCAL_ASR_MODEL_DIR=<解压后的 X-ASR 目录> \
    ///   OPENSPEECH_LOCAL_ASR_AUDIO=<一条 .ogg/.wav 录音> \
    ///   cargo test --release --lib local_asr::engine::tests::real_model -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_model_file_and_streaming_paths_agree() {
        use crate::local_asr::host::child;
        use crate::local_asr::host::protocol::{self, Command, Event, LoadRequest};

        let dir =
            std::path::PathBuf::from(std::env::var("OPENSPEECH_LOCAL_ASR_MODEL_DIR").unwrap());
        let audio = std::path::PathBuf::from(std::env::var("OPENSPEECH_LOCAL_ASR_AUDIO").unwrap());
        let spec = &crate::local_asr::catalog::CATALOG[0];
        // 测试目录没有 model.json 清单，直接按引擎规格加载。
        let EngineSpec::SherpaOnlineTransducer {
            encoder,
            decoder,
            joiner,
            tokens,
        } = spec.engine;
        let load_dir = |d: &Path| -> Result<SharedEngine, LocalAsrError> {
            Ok(Arc::new(sherpa_transducer::SherpaTransducerEngine::load(
                spec.id,
                &d.join(encoder),
                &d.join(decoder),
                &d.join(joiner),
                &d.join(tokens),
                inference_threads(),
            )?))
        };
        let t = std::time::Instant::now();
        let engine = load_dir(&dir).unwrap();
        println!("load_ms={}", t.elapsed().as_millis());

        let samples = crate::local_asr::audio_file::load_mono_16k(&audio).unwrap();
        let t = std::time::Instant::now();
        let file_text = transcribe_samples(engine, &samples);
        println!("file  ({}ms): {file_text}", t.elapsed().as_millis());
        assert!(!file_text.is_empty());

        // 流式路径：按 10ms 帧编码成子进程协议，跑一遍 child::serve。
        let mut input = Vec::new();
        let req = LoadRequest {
            model_id: spec.id.into(),
            dir: dir.to_string_lossy().into_owned(),
            threads: inference_threads(),
        };
        protocol::write_command(&mut input, &Command::Load(req)).unwrap();
        protocol::write_command(&mut input, &Command::Start).unwrap();
        for chunk in samples.chunks(160) {
            protocol::write_command(&mut input, &Command::Audio(chunk.to_vec())).unwrap();
        }
        protocol::write_command(&mut input, &Command::Finish).unwrap();
        let mut out = Vec::new();
        let factory = |r: &LoadRequest| load_dir(Path::new(&r.dir));
        let t = std::time::Instant::now();
        child::serve(&mut input.as_slice(), &mut out, &factory).unwrap();
        let stream_text: String = String::from_utf8(out)
            .unwrap()
            .lines()
            .filter_map(protocol::parse_event)
            .filter_map(|e| match e {
                Event::Final { text } => Some(text),
                _ => None,
            })
            .collect();
        println!(
            "stream ({}ms incl. load): {stream_text}",
            t.elapsed().as_millis()
        );
        assert_eq!(stream_text, file_text);
    }
}
