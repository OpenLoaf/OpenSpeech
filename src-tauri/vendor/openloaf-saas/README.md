# openloaf-saas (Rust SDK vendor bundle)

本目录是 **可拷贝到任意 Rust 项目的 vendor 包**。消费项目把整个目录放到自己仓库（比如 `vendor/openloaf-saas/`），然后在 `Cargo.toml` 里用 path 依赖引用即可。

> 版本独立于 Node 包 `@openloaf-saas/sdk`，详见 `CHANGELOG.md`。首发 v0.1.0 只覆盖 **登录认证** + **v3 工具（tools capabilities / tool execute）**。

## 消费侧用法

### 1. 把本目录拷进你的项目

```
your-repo/
└── vendor/openloaf-saas/      ← 整个目录搬过去
    ├── VERSION
    ├── Cargo.toml
    ├── build.rs
    ├── src/lib.rs
    └── libs/...
```

### 2. 在 `Cargo.toml` 加依赖

```toml
[dependencies]
openloaf-saas = { path = "vendor/openloaf-saas" }
```

### 3. 写代码

```rust
use openloaf_saas::{SaaSClient, SaaSClientConfig, V3ToolExecuteRequest, AuthClientInfo};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 可选：启动时校验 wrapper 版本 ↔ 预编译 core 版本一致
    openloaf_saas::check_abi()?;

    let client = SaaSClient::new(SaaSClientConfig {
        base_url: "https://saas.example.com".into(),
        locale: Some("zh-CN".into()),
        ..Default::default()
    });

    // 登录码换 token
    let info = AuthClientInfo {
        app_id: Some("my-rust-app".into()),
        app_version: Some(env!("CARGO_PKG_VERSION").into()),
        platform: Some(std::env::consts::OS.into()),
        ..Default::default()
    };
    let session = client.auth().exchange(&login_code, Some(&info))?;
    client.set_access_token(Some(session.access_token.clone()));

    // 调 v3 webSearch
    let req = V3ToolExecuteRequest::new("webSearch")
        .with_inputs(serde_json::json!({ "query": "OpenLoaf" }));
    let resp = client.ai().v3_tool_execute(&req)?;
    println!("credits: {}, data: {}", resp.credits_consumed, resp.data);
    Ok(())
}
```

### 4. 支持的 target

看 `libs/` 目录。如果你的 target 没有对应子目录，`cargo build` 会在 `build.rs` 阶段直接 panic，提示你到 openloaf-saas 仓库生成对应平台的预编译产物。

## 错误处理

```rust
use openloaf_saas::SaaSError;

match client.ai().v3_tool_execute(&req) {
    Ok(resp) => { /* ... */ }
    Err(SaaSError::Http { status: 402, .. }) => { /* 积分不足 */ }
    Err(SaaSError::Http { status, message, body }) => eprintln!("http {status}: {message}"),
    Err(SaaSError::Network(msg)) => eprintln!("network: {msg}"),
    Err(SaaSError::Decode(msg)) => eprintln!("decode: {msg}"),
    Err(SaaSError::AbiMismatch { wrapper, core }) => eprintln!("版本错配: wrapper={wrapper}, core={core}"),
    Err(SaaSError::Input(msg)) => eprintln!("input: {msg}"),
}
```

## 对照 Node SDK

| `@openloaf-saas/sdk` | `openloaf-saas` (Rust) |
|----------------------|------------------------|
| `client.auth.exchange(code, info?)` | `client.auth().exchange(code, Some(&info))` |
| `client.auth.refresh(token, info?)` | `client.auth().refresh(token, Some(&info))` |
| `client.auth.logout(token)` | `client.auth().logout(token)` |
| `client.ai.toolsCapabilities()` | `client.ai().tools_capabilities()` |
| `client.ai.v3ToolExecute(payload)` | `client.ai().v3_tool_execute(&payload)` |

## 架构

```
consumer project
   │
   │  path dep
   ▼
vendor/openloaf-saas/              ← 本目录，开源
├── src/lib.rs                     ← safe Rust wrapper
├── build.rs                       ← 链接 libs/{TARGET}/libopenloaf_saas_core.a
└── libs/{TARGET}/                 ← 预编译静态库（闭源）
        libopenloaf_saas_core.a
              │
              │  C ABI: openloaf_saas_call(json_in) -> json_out
              ▼
        实现（闭源，来自 openloaf-saas 仓库的 packages/sdk-rust/）
```

整个 FFI 协议只有 3 个函数：`openloaf_saas_call` / `openloaf_saas_free_string` / `openloaf_saas_version`。所有业务调用通过 JSON envelope 分发，新增接口只需扩展 `method` 取值，不影响已发布 wrapper 的 ABI。
