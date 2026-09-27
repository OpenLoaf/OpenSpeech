// Orca（多项目 AI 编码终端，com.stablyai.orca）当前选中的项目目录。
//
// Orca 窗口标题恒为「Orca」，看标题分不出在哪个项目里说话；它给自带 CLI 开了一个本地
// RPC：`orca-runtime.json`（0600）里记着 unix socket 地址和 authToken，发一行 JSON
// 调 `worktree.ps`，返回全部 worktree，UI 当前选中的那条 `isActive=true`。切换项目后
// 约 150ms 即可查到，一次调用本机实测几十 ms。
//
// 只走 RPC，不读它的 profile-state.db 兜底：连不上就当没有项目信息，听写照常。
// 坑（2026-09 调研 Orca 1.4.x 源码）：
// - `worktree current` / `--worktree active` 按调用方 cwd 解析，不是 UI 选中项，不能用。
// - SSH 远程项目同样出现在列表里，只认 hostId=local 的（路径在本机才有意义）。
// - authToken 等同本机免密控制 Orca 终端，只在内存里用，绝不进日志。

use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

use serde::Deserialize;

pub const BUNDLE_ID: &str = "com.stablyai.orca";

/// 整次查询（连接 + 读写）的超时。本机 socket 正常几十 ms，超了多半是 Orca 卡住，放弃。
const TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Runtime {
    transports: Vec<Transport>,
    auth_token: String,
}

#[derive(Deserialize)]
struct Transport {
    kind: String,
    endpoint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Worktree {
    path: String,
    #[serde(default)]
    host_id: Option<String>,
    #[serde(default)]
    is_active: bool,
}

/// 当前在 Orca 里选中的本机项目目录。Orca 没开 / 连不上 / 选中的是远程项目 → None。
pub fn active_project() -> Option<String> {
    let runtime = read_runtime()?;
    let reply = query(&runtime)?;
    pick_active(&reply)
}

#[cfg(target_os = "macos")]
fn runtime_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::Path::new(&home).join("Library/Application Support/orca/orca-runtime.json"))
}

#[cfg(not(target_os = "macos"))]
fn runtime_path() -> Option<std::path::PathBuf> {
    // Windows 版 Orca 的 runtime 走命名管道，暂不支持；Linux 未验证，先不接。
    None
}

fn read_runtime() -> Option<Runtime> {
    let raw = std::fs::read(runtime_path()?).ok()?;
    serde_json::from_slice(&raw).ok()
}

#[cfg(unix)]
fn query(runtime: &Runtime) -> Option<serde_json::Value> {
    use std::os::unix::net::UnixStream;

    let endpoint = &runtime
        .transports
        .iter()
        .find(|t| t.kind == "unix")?
        .endpoint;
    let mut stream = UnixStream::connect(endpoint).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut req = serde_json::to_vec(&serde_json::json!({
        "id": id,
        "authToken": runtime.auth_token,
        "method": "worktree.ps",
        "params": { "limit": 10000 },
    }))
    .ok()?;
    req.push(b'\n');
    stream.write_all(&req).ok()?;
    read_reply(BufReader::new(stream), &id)
}

#[cfg(not(unix))]
fn query(_runtime: &Runtime) -> Option<serde_json::Value> {
    None
}

/// 回包是 NDJSON：可能先来若干 `_keepalive` 帧，取 id 对得上的那一帧。
fn read_reply<R: BufRead>(reader: R, id: &str) -> Option<serde_json::Value> {
    for line in reader.lines() {
        let line = line.ok()?;
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if msg.get("id").and_then(|v| v.as_str()) != Some(id) {
            continue;
        }
        if msg.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return None;
        }
        return msg.get("result").cloned();
    }
    None
}

fn pick_active(result: &serde_json::Value) -> Option<String> {
    let list: Vec<Worktree> = serde_json::from_value(result.get("worktrees")?.clone()).ok()?;
    list.into_iter()
        .find(|w| w.is_active && w.host_id.as_deref().is_none_or(|h| h == "local"))
        .map(|w| w.path)
        .filter(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 远程项目即便是当前选中项也不能用：路径在本机不存在，拿去当上下文只会误导。
    #[test]
    fn picks_active_local_worktree_only() {
        let result = serde_json::json!({ "worktrees": [
            { "path": "/a", "hostId": "local", "isActive": false },
            { "path": "/remote", "hostId": "ssh-1", "isActive": true },
        ]});
        assert_eq!(pick_active(&result), None);

        let result = serde_json::json!({ "worktrees": [
            { "path": "/a", "hostId": "local", "isActive": false },
            { "path": "/b", "hostId": "local", "isActive": true },
        ]});
        assert_eq!(pick_active(&result).as_deref(), Some("/b"));
    }

    #[test]
    fn reply_skips_keepalive_and_foreign_ids() {
        let wire = concat!(
            "{\"_keepalive\":true}\n",
            "{\"id\":\"other\",\"ok\":true,\"result\":{\"x\":1}}\n",
            "{\"id\":\"me\",\"ok\":true,\"result\":{\"worktrees\":[]}}\n",
        );
        let got = read_reply(wire.as_bytes(), "me").unwrap();
        assert!(got.get("worktrees").is_some());
    }

    #[test]
    fn failed_reply_yields_none() {
        let wire = "{\"id\":\"me\",\"ok\":false,\"error\":{\"message\":\"unauthorized\"}}\n";
        assert!(read_reply(wire.as_bytes(), "me").is_none());
    }

    // 本机真 Orca 冒烟：`cargo test --lib orca::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_active_project() {
        let t = std::time::Instant::now();
        let p = active_project();
        println!("active project = {p:?} in {:?}", t.elapsed());
        assert!(p.is_some());
    }
}
