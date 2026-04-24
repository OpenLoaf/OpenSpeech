// OpenLoaf OAuth 回调本地 HTTP server。
//
// SaaS 后端完成 OAuth 后会 302 到：
//   http://127.0.0.1:<port>/auth/callback?code=<loginCode>&returnTo=openloaf-login:<state>
//
// 我们：
//   1. 启动时 bind 一个随机 loopback 端口，常驻一个处理线程
//   2. 收到请求解析 code + state，立即回 HTML 让浏览器显示"登录成功"
//   3. 把 (state, code) 异步派发给 openloaf::handle_login_callback
//      由它用 SDK 换 token、写 Keychain、emit 事件给前端

use std::net::TcpListener;
use std::thread;

use tauri::AppHandle;
use tiny_http::{Header, Response, Server};
use url::Url;

use super::handle_login_callback;

const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>登录成功 · OpenSpeech</title>
  <style>
    html,body{height:100%;margin:0;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;background:#000;color:#fff}
    .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;text-align:center;padding:24px}
    h1{font-size:20px;font-weight:600;margin:0;letter-spacing:.02em}
    p{font-size:13px;color:#888;margin:0}
    .dot{width:10px;height:10px;background:#ffcc00}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="dot" aria-hidden></div>
    <h1>登录成功</h1>
    <p>你可以关闭此页面，回到 OpenSpeech 继续操作。</p>
  </div>
</body>
</html>"#;

const BAD_REQUEST_HTML: &str = r#"<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div>回调参数不完整，可关闭此页面。</div>
</body></html>"#;

/// 启动本地回调 server；返回所 bind 的端口。
/// port=0 交给 OS 分配一个可用端口。
pub fn start(app: AppHandle) -> std::io::Result<u16> {
    // 先用 std::net::TcpListener 拿到端口，再交给 tiny_http。
    // tiny_http::Server::from_listener 接受已 bind 的 listener。
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let server = Server::from_listener(listener, None)
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    thread::spawn(move || {
        for req in server.incoming_requests() {
            let url = req.url().to_string();

            // 只处理 /auth/callback；其他路径给个简单 404，避免泄露端口用途。
            if !url.starts_with("/auth/callback") {
                let _ = req.respond(Response::from_string("not found").with_status_code(404));
                continue;
            }

            let parsed = match parse_callback(&url) {
                Some(v) => v,
                None => {
                    let _ = req.respond(html_response(BAD_REQUEST_HTML, 400));
                    continue;
                }
            };

            // 先回响应，避免浏览器卡住。
            let _ = req.respond(html_response(SUCCESS_HTML, 200));

            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                handle_login_callback(&app_handle, parsed.state, parsed.code).await;
            });
        }
    });

    Ok(port)
}

struct CallbackParams {
    code: String,
    state: String,
}

fn parse_callback(raw_url: &str) -> Option<CallbackParams> {
    // tiny_http 给的是 path+query，需要补一个 origin 才能喂给 url::Url。
    let full = format!("http://127.0.0.1{raw_url}");
    let url = Url::parse(&full).ok()?;

    let mut code = None;
    let mut return_to = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "returnTo" => return_to = Some(v.into_owned()),
            _ => {}
        }
    }

    let code = code?;
    let return_to = return_to?;
    // returnTo 形如 "openloaf-login:<state>"；截掉前缀拿 state。
    let state = return_to
        .strip_prefix("openloaf-login:")
        .map(|s| s.to_string())?;

    if state.is_empty() {
        return None;
    }

    Some(CallbackParams { code, state })
}

fn html_response(body: &str, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    let content_type = Header::from_bytes(
        &b"Content-Type"[..],
        &b"text/html; charset=utf-8"[..],
    )
    .expect("valid header");
    Response::from_string(body)
        .with_status_code(status)
        .with_header(content_type)
}
