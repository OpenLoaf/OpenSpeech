// 腾讯云实时 ASR WebSocket 帧解析。
//
// WS 协议：
//   - 客户端发：binary frame = PCM16 16k mono；text frame `{"type":"end"}` 表 finish
//   - 服务端回：text frame，统一 JSON 形如 `{code, message, voice_id, message_id, result?, final?}`
//   - 错误：`code != 0` → 服务端紧接着断开连接
//   - 完成：`final == 1` → 服务端正常断开
//
// docs/tencent-asr/websocket-realtime-asr.md

use serde::Deserialize;

/// 与服务端"识别结果 Result 结构体"对应。腾讯所有字段都是 snake_case。
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RealtimeResult {
    /// 0=一段话开始，1=一段话识别中（非稳态 partial），2=一段话结束（稳态 final）
    pub slice_type: u8,
    /// 当前一段话在整个音频流中的序号（从 0 递增，相当于我们这边的 sentence_id）
    pub index: i64,
    #[serde(default)]
    pub start_time: i64,
    #[serde(default)]
    pub end_time: i64,
    #[serde(default)]
    pub voice_text_str: String,
    #[serde(default)]
    pub word_size: i64,
    // word_list 暂不消费（仅词级时间戳场景用）
}

/// 服务端任意一帧 JSON 的统一壳。`final` 是 Rust 关键字，serde rename 处理。
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RealtimeFrame {
    pub code: i32,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub voice_id: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub result: Option<RealtimeResult>,
    /// 1=音频流全部识别结束（连接将被服务端关闭）
    #[serde(default, rename = "final")]
    pub final_flag: Option<i32>,
}

/// 把一帧服务端消息归类成业务事件，便于上层 worker 直接 emit 到前端。
/// 与 stt/mod.rs 现有的 `RealtimeEvent`（来自 SDK）对齐 —— 复用前端事件名 / payload。
#[derive(Debug, Clone, PartialEq)]
pub enum TencentEvent {
    /// 握手响应：code=0 + 无 result + 无 final → 连接成功
    Ready { voice_id: String },
    /// slice_type ∈ {0, 1}
    Partial { sentence_id: i64, text: String },
    /// slice_type == 2
    Final { sentence_id: i64, text: String },
    /// final_flag == 1
    EndOfStream,
    /// code != 0
    Error { code: i32, message: String },
}

/// 解析单条 text frame 为业务事件。`raw` 是 WebSocket 给的 UTF-8 字符串。
pub fn parse_frame(raw: &str) -> Result<TencentEvent, ParseError> {
    let frame: RealtimeFrame = serde_json::from_str(raw).map_err(ParseError::Decode)?;
    if frame.code != 0 {
        return Ok(TencentEvent::Error {
            code: frame.code,
            message: frame.message,
        });
    }
    if frame.final_flag == Some(1) {
        return Ok(TencentEvent::EndOfStream);
    }
    match frame.result {
        Some(r) => match r.slice_type {
            // 0/1 都按"非稳态"处理（0 = 一段话开始，可能是空 partial；1 = partial 中）
            0 | 1 => Ok(TencentEvent::Partial {
                sentence_id: r.index,
                text: r.voice_text_str,
            }),
            2 => Ok(TencentEvent::Final {
                sentence_id: r.index,
                text: r.voice_text_str,
            }),
            other => Err(ParseError::UnknownSliceType(other)),
        },
        None => Ok(TencentEvent::Ready {
            voice_id: frame.voice_id,
        }),
    }
}

#[derive(Debug)]
pub enum ParseError {
    Decode(serde_json::Error),
    UnknownSliceType(u8),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Decode(e) => write!(f, "decode failed: {e}"),
            ParseError::UnknownSliceType(t) => write!(f, "unknown slice_type: {t}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// 错误码 → 稳定字符串（前端按串路由：unauthenticated / quota_exceeded / 等）。
/// 错误码语义见 docs/tencent-asr/websocket-realtime-asr.md §"错误码"。
pub fn classify_error_code(code: i32) -> &'static str {
    match code {
        4002 => "unauthenticated",                // 鉴权失败（SecretId / 签名错）
        4003 => "service_not_enabled",            // AppID 服务未开通
        4004 | 4005 | 4007 => "insufficient_credits", // 资源耗尽 / 欠费 / 资源包不足
        4006 => "rate_limited",                   // 并发超限
        4000 => "rate_limited",                   // 发送过快（语义上是节流）
        4001 => "invalid_params",                 // 参数不合法
        4008 => "idle_timeout",                   // 客户端 15s 未发数据
        4009 => "client_disconnected",            // 客户端主动断
        4010 => "invalid_message",                // 未知文本消息
        5000 | 5001 | 5002 => "transient",        // 偶发服务端错，建议重试
        6001 => "region_blocked",                 // 境外/境内调用错
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_handshake_ack_as_ready() {
        // 文档 §"握手阶段响应" 示例
        let raw = r#"{"code":0,"message":"success","voice_id":"RnKu9FODFHK5FPpsrN"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            TencentEvent::Ready {
                voice_id: "RnKu9FODFHK5FPpsrN".into()
            }
        );
    }

    #[test]
    fn parse_partial_slice_type_0() {
        // slice_type=0 表"一段话开始"，文本可能为空。当 partial 处理。
        let raw = r#"{"code":0,"message":"success","voice_id":"vid","message_id":"vid_1","result":{"slice_type":0,"index":0,"start_time":0,"end_time":1240,"voice_text_str":"实时","word_size":0,"word_list":[]}}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            TencentEvent::Partial {
                sentence_id: 0,
                text: "实时".into(),
            }
        );
    }

    #[test]
    fn parse_partial_slice_type_1() {
        let raw = r#"{"code":0,"message":"success","voice_id":"v","message_id":"v_2","result":{"slice_type":1,"index":0,"start_time":0,"end_time":2000,"voice_text_str":"实时语音","word_size":0,"word_list":[]}}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            TencentEvent::Partial {
                sentence_id: 0,
                text: "实时语音".into(),
            }
        );
    }

    #[test]
    fn parse_final_slice_type_2() {
        // 文档 §"接收消息" 示例
        let raw = r#"{"code":0,"message":"success","voice_id":"RnKu9FODFHK5FPpsrN","message_id":"RnKu9FODFHK5FPpsrN_33_0","result":{"slice_type":2,"index":0,"start_time":0,"end_time":2840,"voice_text_str":"实时语音识别","word_size":0,"word_list":[]}}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            TencentEvent::Final {
                sentence_id: 0,
                text: "实时语音识别".into(),
            }
        );
    }

    #[test]
    fn parse_end_of_stream() {
        // 文档 §"接收消息" 末尾示例
        let raw = r#"{"code":0,"message":"success","voice_id":"CzhjnqBkv8lk5pRUxhpX","message_id":"CzhjnqBkv8lk5pRUxhpX_241","final":1}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(ev, TencentEvent::EndOfStream);
    }

    #[test]
    fn parse_error_frame() {
        // 文档 §"接收消息" 示例
        let raw = r#"{"code":4008,"message":"后台识别服务器音频分片等待超时","voice_id":"CzhjnqBkv8lk5pRUxhpX","message_id":"CzhjnqBkv8lk5pRUxhpX_241"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            TencentEvent::Error {
                code: 4008,
                message: "后台识别服务器音频分片等待超时".into(),
            }
        );
    }

    #[test]
    fn parse_handles_minimal_required_fields() {
        // 极简：仅 code（防御性，腾讯不太可能这么发，但解码器要稳）
        let raw = r#"{"code":0}"#;
        let ev = parse_frame(raw).unwrap();
        // 没 result + 没 final → 当作 Ready（voice_id 为空）
        assert_eq!(ev, TencentEvent::Ready { voice_id: "".into() });
    }

    #[test]
    fn parse_unknown_slice_type_is_error() {
        // 防御性：未来腾讯加新 slice_type 时不要静默丢
        let raw = r#"{"code":0,"voice_id":"v","result":{"slice_type":9,"index":0,"voice_text_str":""}}"#;
        let r = parse_frame(raw);
        assert!(matches!(r, Err(ParseError::UnknownSliceType(9))));
    }

    #[test]
    fn parse_decode_error_on_garbage() {
        let r = parse_frame("not json");
        assert!(matches!(r, Err(ParseError::Decode(_))));
    }

    #[test]
    fn classify_error_code_covers_all_documented() {
        // 文档"错误码"表里的每一个码都必须有映射，不能落到 "unknown"
        let codes = [4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010,
                     5000, 5001, 5002, 6001];
        for c in codes {
            assert_ne!(
                classify_error_code(c), "unknown",
                "documented error code {c} must be classified"
            );
        }
    }

    #[test]
    fn classify_error_code_unknown_for_undocumented() {
        assert_eq!(classify_error_code(9999), "unknown");
        assert_eq!(classify_error_code(0), "unknown"); // code=0 不该走这路径
    }
}
