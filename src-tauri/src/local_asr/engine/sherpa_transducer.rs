// sherpa-onnx 流式 transducer（zipformer 系，如 X-ASR）。
//
// 端点检测用 sherpa 内置三规则（与 sherpa 官方示例同值）：
//   rule1 无任何输出时尾部静音 2.4s、rule2 有输出后尾部静音 1.2s、rule3 单句 20s
// 命中后当前句定稿（Final）并 reset，后续语音算下一句——对应 RealtimeBackendEvent
// 的 sentence_id 递增语义。

use std::path::Path;
use std::sync::Arc;

use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use super::{LocalAsrEngine, LocalAsrStream, SAMPLE_RATE, StreamUpdate, tidy_text};
use crate::local_asr::error::LocalAsrError;

/// finish 时补的尾部静音：流式模型要看到一段静音才会把最后几个字吐出来。
/// 0.5s 实测不够（X-ASR 160ms chunk 带 look-ahead，句尾「转换」会丢「换」），1.0s 稳定；
/// 多出的 0.5s 解码约 25ms，只加在松键之后。
const TAIL_PADDING_SECS: f32 = 1.0;

pub struct SherpaTransducerEngine {
    model_id: &'static str,
    recognizer: OnlineRecognizer,
}

impl SherpaTransducerEngine {
    pub fn load(
        model_id: &'static str,
        encoder: &Path,
        decoder: &Path,
        joiner: &Path,
        tokens: &Path,
        num_threads: i32,
    ) -> Result<Self, LocalAsrError> {
        let path = |p: &Path| Some(p.to_string_lossy().into_owned());
        let mut config = OnlineRecognizerConfig::default();
        config.model_config.transducer.encoder = path(encoder);
        config.model_config.transducer.decoder = path(decoder);
        config.model_config.transducer.joiner = path(joiner);
        config.model_config.tokens = path(tokens);
        config.model_config.num_threads = num_threads;
        config.decoding_method = Some("greedy_search".into());
        config.enable_endpoint = true;
        config.rule1_min_trailing_silence = 2.4;
        config.rule2_min_trailing_silence = 1.2;
        config.rule3_min_utterance_length = 20.0;

        let recognizer = OnlineRecognizer::create(&config).ok_or_else(|| {
            LocalAsrError::Load(format!(
                "sherpa OnlineRecognizer::create failed for {model_id}"
            ))
        })?;
        Ok(Self {
            model_id,
            recognizer,
        })
    }
}

impl LocalAsrEngine for SherpaTransducerEngine {
    fn model_id(&self) -> &str {
        self.model_id
    }

    fn open_stream(self: Arc<Self>) -> Box<dyn LocalAsrStream> {
        let stream = self.recognizer.create_stream();
        Box::new(SherpaTransducerStream {
            engine: self,
            stream,
            last_partial: String::new(),
            finished: false,
        })
    }
}

struct SherpaTransducerStream {
    // 持有 Arc 保证 recognizer 活得比 stream 长（stream 的 C 句柄依赖 recognizer）。
    engine: Arc<SherpaTransducerEngine>,
    stream: OnlineStream,
    last_partial: String,
    finished: bool,
}

impl SherpaTransducerStream {
    fn current_text(&self) -> String {
        self.engine
            .recognizer
            .get_result(&self.stream)
            .map(|r| tidy_text(&r.text))
            .unwrap_or_default()
    }
}

impl LocalAsrStream for SherpaTransducerStream {
    fn accept(&mut self, samples: &[f32]) {
        if self.finished || samples.is_empty() {
            return;
        }
        self.stream.accept_waveform(SAMPLE_RATE as i32, samples);
    }

    fn finish(&mut self) {
        if self.finished {
            return;
        }
        let pad = vec![0.0f32; (SAMPLE_RATE as f32 * TAIL_PADDING_SECS) as usize];
        self.stream.accept_waveform(SAMPLE_RATE as i32, &pad);
        self.stream.input_finished();
        self.finished = true;
    }

    fn drain(&mut self, out: &mut Vec<StreamUpdate>) {
        let rec = &self.engine.recognizer;
        while rec.is_ready(&self.stream) {
            rec.decode(&self.stream);
        }

        let text = self.current_text();
        if rec.is_endpoint(&self.stream) {
            if !text.is_empty() {
                out.push(StreamUpdate::Final(text));
            }
            rec.reset(&self.stream);
            self.last_partial.clear();
            return;
        }

        if self.finished {
            // 输入已结束且解码排空：剩余文本就是最后一句，直接定稿。
            if !text.is_empty() {
                out.push(StreamUpdate::Final(text));
            }
            rec.reset(&self.stream);
            self.last_partial.clear();
            return;
        }

        if text != self.last_partial {
            self.last_partial = text.clone();
            out.push(StreamUpdate::Partial(text));
        }
    }
}
