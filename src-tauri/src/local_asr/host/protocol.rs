// 主进程 ⇄ 推理子进程的线协议。
//
// 下行（主 → 子，stdin）：二进制帧 `[tag: u8][len: u32 LE][payload]`。音频是大头
// （16kHz f32 每秒 64KB），走二进制省掉 JSON / base64 的编解码与膨胀。
// 上行（子 → 主，stdout）：一行一个 JSON 事件，量小、好调试。
// stderr 是子进程日志，主进程逐行转进 log。
//
// 子进程与主进程是同一个二进制，协议两端同版本编译，不做版本协商。

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// 单帧上限：防止损坏的长度字段让子进程一次分配几个 GB。
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// 加载模型（已加载同一模型则直接回 Loaded）。
    Load(LoadRequest),
    /// 开一路新的识别流；上一路未结束的流被丢弃。
    Start,
    /// 16kHz 单声道 f32 采样。
    Audio(Vec<f32>),
    /// 音频送完：冲刷尾句，之后子进程回 End。
    Finish,
    /// 丢弃当前流（取消 / 会话异常结束），不回 End。
    Abort,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRequest {
    pub model_id: String,
    /// 已安装的模型目录（主进程已校验过安装完整性）。
    pub dir: String,
    pub threads: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Loaded {
        #[serde(rename = "modelId")]
        model_id: String,
        ms: u64,
    },
    LoadFailed {
        code: String,
        message: String,
    },
    Partial {
        text: String,
    },
    Final {
        text: String,
    },
    /// Finish 之后尾句已全部吐完。
    End,
}

const TAG_LOAD: u8 = b'L';
const TAG_START: u8 = b'S';
const TAG_AUDIO: u8 = b'A';
const TAG_FINISH: u8 = b'F';
const TAG_ABORT: u8 = b'X';

pub fn write_command<W: Write>(w: &mut W, cmd: &Command) -> io::Result<()> {
    let (tag, payload): (u8, Vec<u8>) = match cmd {
        Command::Load(req) => (
            TAG_LOAD,
            serde_json::to_vec(req).map_err(|e| io::Error::other(e.to_string()))?,
        ),
        Command::Start => (TAG_START, Vec::new()),
        Command::Audio(samples) => (
            TAG_AUDIO,
            samples.iter().flat_map(|s| s.to_le_bytes()).collect(),
        ),
        Command::Finish => (TAG_FINISH, Vec::new()),
        Command::Abort => (TAG_ABORT, Vec::new()),
    };
    w.write_all(&[tag])?;
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(&payload)?;
    w.flush()
}

/// 读一帧；对端关闭（EOF 落在帧边界上）返回 Ok(None)。
pub fn read_command<R: Read>(r: &mut R) -> io::Result<Option<Command>> {
    let mut tag = [0u8; 1];
    match r.read_exact(&mut tag) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len}"),
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    let bad = |m: String| io::Error::new(io::ErrorKind::InvalidData, m);
    let cmd = match tag[0] {
        TAG_LOAD => {
            Command::Load(serde_json::from_slice(&payload).map_err(|e| bad(e.to_string()))?)
        }
        TAG_START => Command::Start,
        TAG_AUDIO => {
            if !payload.len().is_multiple_of(4) {
                return Err(bad(format!("audio payload not f32-aligned: {len}")));
            }
            Command::Audio(
                payload
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect(),
            )
        }
        TAG_FINISH => Command::Finish,
        TAG_ABORT => Command::Abort,
        other => return Err(bad(format!("unknown tag {other}"))),
    };
    Ok(Some(cmd))
}

pub fn write_event<W: Write>(w: &mut W, ev: &Event) -> io::Result<()> {
    let mut line = serde_json::to_vec(ev).map_err(|e| io::Error::other(e.to_string()))?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()
}

pub fn parse_event(line: &str) -> Option<Event> {
    serde_json::from_str(line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_round_trip() {
        let cmds = vec![
            Command::Load(LoadRequest {
                model_id: "m".into(),
                dir: "/tmp/模型".into(),
                threads: 4,
            }),
            Command::Start,
            Command::Audio(vec![0.0, -1.0, 0.5, 1.0]),
            Command::Audio(Vec::new()),
            Command::Finish,
            Command::Abort,
        ];
        let mut buf = Vec::new();
        for c in &cmds {
            write_command(&mut buf, c).unwrap();
        }
        let mut r = buf.as_slice();
        for c in &cmds {
            assert_eq!(read_command(&mut r).unwrap().as_ref(), Some(c));
        }
        assert_eq!(read_command(&mut r).unwrap(), None);
    }

    // 长度字段损坏时必须报错而不是按它去分配内存。
    #[test]
    fn oversized_frame_is_rejected() {
        let mut buf = vec![TAG_AUDIO];
        buf.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(read_command(&mut buf.as_slice()).is_err());
    }

    #[test]
    fn events_round_trip_as_json_lines() {
        let evs = vec![
            Event::Loaded {
                model_id: "m".into(),
                ms: 1500,
            },
            Event::LoadFailed {
                code: "local_model_load_failed".into(),
                message: "x".into(),
            },
            Event::Partial {
                text: "你好".into(),
            },
            Event::Final {
                text: "你好。".into(),
            },
            Event::End,
        ];
        let mut buf = Vec::new();
        for e in &evs {
            write_event(&mut buf, e).unwrap();
        }
        let text = String::from_utf8(buf).unwrap();
        let parsed: Vec<Event> = text.lines().filter_map(parse_event).collect();
        assert_eq!(parsed, evs);
    }
}
