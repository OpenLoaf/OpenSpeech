//! 最小用法示例：打印 core 静态库版本，做一次 ABI 自检，
//! 并演示三类调用（auth / v3 tool execute / realtime WebSocket）。
//!
//! 运行：
//! ```bash
//! cargo run --example basic
//! ```
//!
//! 可选环境变量：
//! * `BASE_URL`         —— 服务端地址（默认 https://saas.example.com，只做演示）
//! * `LOGIN_CODE`       —— 设置后会调用 auth.exchange + user.current + tools_capabilities + webSearch
//! * `REALTIME_FEATURE` —— 设置后会打开一条 realtime WebSocket，打印 Ready / Credits 事件
//!   （不发送音频，只做连通性验证）

use std::time::Duration;

use openloaf_saas::{
    OAuthStartOptions, RealtimeEvent, SDK_VERSION, SaaSClient, SaaSClientConfig,
    V3ToolExecuteRequest, check_abi,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("wrapper SDK_VERSION = {SDK_VERSION}");
    println!("core     version    = {}", openloaf_saas::core_version());
    check_abi()?; // 版本不对会直接返回 AbiMismatch

    let base_url = std::env::var("BASE_URL").unwrap_or_else(|_| "https://saas.example.com".into());
    let client = SaaSClient::new(SaaSClientConfig {
        base_url,
        locale: Some("zh-CN".into()),
        ..Default::default()
    });

    // OAuth start URL 构造不需要 token，任何时候都可以调用
    let google_url = client
        .auth()
        .google_start_url(&OAuthStartOptions::new().from("electron").port(53219))?;
    println!("google start url: {google_url}");

    if let Ok(login_code) = std::env::var("LOGIN_CODE") {
        let session = client.auth().exchange(&login_code, None)?;
        client.set_access_token(Some(session.access_token.clone()));
        println!("logged in as {:?}", session.user);

        // user.self：拿当前用户完整档案（含会员、积分余额）
        let me = client.user().current()?;
        println!(
            "self: id={} provider={} level={:?} credits={}",
            me.user.id, me.user.provider, me.user.membership_level, me.user.credits_balance
        );

        let caps = client.ai().tools_capabilities()?;
        for feature in &caps.data.features {
            println!("- {}", feature.id());
        }

        let req = V3ToolExecuteRequest::new("webSearch")
            .with_inputs(serde_json::json!({ "query": "OpenLoaf" }));
        let resp = client.ai().v3_tool_execute(&req)?;
        println!("credits consumed: {}", resp.credits_consumed);

        // ── Realtime 工具 WebSocket 演示 ──────────────────────────
        if let Ok(feature) = std::env::var("REALTIME_FEATURE") {
            println!("connecting realtime feature: {feature}");
            let sess = client.realtime().connect(&feature)?;
            sess.send_start(
                Some(serde_json::json!({})),
                Some(serde_json::json!({})),
            )?;
            // 演示：只跑最多 5 秒，抓几条事件就退出
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match sess.recv_event_timeout(Duration::from_millis(500))? {
                    Some(RealtimeEvent::Ready {
                        session_id,
                        started_at,
                    }) => {
                        println!("ready sessionId={session_id} startedAt={started_at}")
                    }
                    Some(RealtimeEvent::Credits {
                        consumed_seconds,
                        remaining_credits,
                        ..
                    }) => {
                        println!("credits sec={consumed_seconds} remaining={remaining_credits}")
                    }
                    Some(RealtimeEvent::Closed {
                        reason,
                        total_credits,
                        ..
                    }) => {
                        println!("closed reason={reason} total_credits={total_credits}");
                        break;
                    }
                    Some(RealtimeEvent::Error { code, message }) => {
                        println!("error {code}: {message}");
                        break;
                    }
                    Some(other) => println!("event = {other:?}"),
                    None => {}
                }
            }
            sess.send_finish().ok();
            sess.close().ok();
        } else {
            println!("(set REALTIME_FEATURE to exercise WebSocket)");
        }
    } else {
        println!("(set LOGIN_CODE to exercise auth + tools + realtime)");
    }

    Ok(())
}
