// 本地模型清单：闭集、编译期写死。
//
// 为什么不做成远端下发的 JSON：
// - 每个模型对应的推理引擎（EngineSpec）必须是本版本二进制认识的变体，远端加一个
//   引擎类型客户端也跑不了，下发只会制造「列表里有、点了报错」的假选项；
// - sha256 / 文件清单是安全边界，跟二进制一起签名发版比运行时拉取更可信。
//
// 新增模型 = 在 CATALOG 里加一条 + 前端 i18n `settings:local_model.models.<id>.*`
// 补介绍文案。新增推理引擎（非 sherpa 在线 transducer）= 加 EngineSpec 变体 +
// engine/ 下实现 LocalAsrEngine，其余链路（下载 / 安装 / 调度 / UI）不用动。
//
// memory_mb 是实测进程峰值（scripts/local-asr-bench，150 条真实听写录音，
// M3 Max 4 线程），不是权重文件大小；UI 直接展示这个数，改模型必须重测。

/// 推理引擎类型 + 该引擎需要的文件（相对模型安装目录）。
#[derive(Debug, Clone, Copy)]
pub enum EngineSpec {
    /// sherpa-onnx 流式 transducer（zipformer 系）：边说边出字，自带端点检测。
    SherpaOnlineTransducer {
        encoder: &'static str,
        decoder: &'static str,
        joiner: &'static str,
        tokens: &'static str,
    },
}

#[derive(Debug, Clone, Copy)]
pub enum ArchiveFormat {
    TarBz2,
}

#[derive(Debug, Clone, Copy)]
pub struct ArchiveSpec {
    /// 按顺序尝试的下载源；前一个失败（网络 / 非 2xx）才换下一个。
    pub urls: &'static [&'static str],
    pub sha256: &'static str,
    pub bytes: u64,
    pub format: ArchiveFormat,
    /// 归档内的顶层目录，解压时剥掉，文件直接落到模型安装目录。
    pub strip_prefix: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    /// 稳定 id：持久化进 settings.json、作为安装目录名、前端 i18n key。改名 = 破坏性变更。
    pub id: &'static str,
    /// 品牌名，不翻译。
    pub display_name: &'static str,
    pub author: &'static str,
    pub license: &'static str,
    pub homepage: &'static str,
    /// ISO 639-1。
    pub languages: &'static [&'static str],
    /// 解压后保留文件的总大小（字节）。
    pub disk_bytes: u64,
    /// 实测推理进程峰值内存（MB）。
    pub memory_mb: u32,
    pub streaming: bool,
    pub punctuation: bool,
    pub archive: ArchiveSpec,
    /// 解压后要保留的文件（相对 strip_prefix 之后的路径）；归档里其余文件（测试音频、
    /// 脚本）不落盘。也用于校验「已安装」。
    pub files: &'static [&'static str],
    pub engine: EngineSpec,
}

pub const CATALOG: &[ModelSpec] = &[ModelSpec {
    id: "xasr-zh-en-streaming-160ms-int8",
    display_name: "X-ASR",
    author: "GilgameshWind",
    license: "Apache-2.0",
    homepage: "https://huggingface.co/GilgameshWind/X-ASR-zh-en",
    languages: &["zh", "en"],
    disk_bytes: 169_229_000,
    memory_mb: 550,
    streaming: true,
    punctuation: true,
    archive: ArchiveSpec {
        // 自建镜像在前（国内腾讯 CDN 回源 R2 → R2 自定义域），GitHub 官方 release 兜底。
        // 路径按归档文件名定、内容由 sha256 锁死，永不覆盖；换归档 = 换文件名。
        urls: &[
            "https://openspeech-cdn.hexems.com/models/asr/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2",
            "https://openspeech-r2.hexems.com/models/asr/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2",
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2",
        ],
        sha256: "8a6fca056e1a342546edd78be4d50274e2c01898e7b8ae8fc336f6410319c399",
        bytes: 133_898_007,
        format: ArchiveFormat::TarBz2,
        strip_prefix: "sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05",
    },
    files: &[
        "encoder.int8.onnx",
        "decoder.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
    ],
    engine: EngineSpec::SherpaOnlineTransducer {
        encoder: "encoder.int8.onnx",
        decoder: "decoder.onnx",
        joiner: "joiner.int8.onnx",
        tokens: "tokens.txt",
    },
}];

pub fn find(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 引擎引用的文件必须都在保留清单里，否则解压后缺文件、加载必失败。
    #[test]
    fn engine_files_are_kept_after_extraction() {
        for m in CATALOG {
            let EngineSpec::SherpaOnlineTransducer {
                encoder,
                decoder,
                joiner,
                tokens,
            } = m.engine;
            for f in [encoder, decoder, joiner, tokens] {
                assert!(m.files.contains(&f), "{}: {f} not in files", m.id);
            }
        }
    }

    // id 是目录名兼持久化 key：只允许小写字母数字和连字符，杜绝路径穿越。
    #[test]
    fn ids_are_path_safe_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for m in CATALOG {
            assert!(
                m.id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{}",
                m.id
            );
            assert!(seen.insert(m.id), "duplicate id {}", m.id);
            assert_eq!(m.archive.sha256.len(), 64);
            assert!(!m.archive.urls.is_empty());
        }
    }
}
