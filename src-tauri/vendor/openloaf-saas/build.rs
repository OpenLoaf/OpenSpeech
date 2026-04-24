//! build.rs — 把 libs/{TARGET}/ 下的预编译静态库告诉 rustc 去链接。
//!
//! 该文件会被 cargo 在消费侧每次 build 执行，负责：
//! 1. 按 `TARGET` 环境变量选择对应平台的 `.a` / `.lib`
//! 2. 声明 `rustc-link-search` 和 `rustc-link-lib`
//! 3. 补上各操作系统需要的系统框架（Security/CoreFoundation/ntdll 等）
//!
//! 如果目标平台对应的目录不存在，会在构建阶段直接 panic，提示到 openloaf-saas
//! 仓库重新生成 bundle。

use std::path::PathBuf;

fn main() {
    let target = std::env::var("TARGET").expect("TARGET env var not set");
    let manifest_dir: PathBuf = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR env var not set")
        .into();
    let lib_dir = manifest_dir.join("libs").join(&target);
    let lib_file = if target.contains("windows-msvc") {
        lib_dir.join("openloaf_saas_core.lib")
    } else {
        lib_dir.join("libopenloaf_saas_core.a")
    };

    // 如果该平台预编译产物不存在，直接报错，避免链接时才失败
    if !lib_file.is_file() {
        panic!(
            "openloaf-saas: target `{target}` 没有预编译静态库。\n\
             期望文件: {}\n\
             解决办法：到 openloaf-saas 仓库运行 `scripts/build-sdk-rust-bundle.sh --target {target}`\n\
             生成该平台的 .a/.lib 后，重新拷贝整个 vendor 目录。",
            lib_file.display()
        );
    }

    println!("cargo:rerun-if-changed=libs/{target}");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=openloaf_saas_core");

    // 各平台需要的系统库
    if target.contains("apple-darwin") {
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }
    if target.contains("windows-msvc") {
        println!("cargo:rustc-link-lib=ntdll");
        println!("cargo:rustc-link-lib=ncrypt");
        println!("cargo:rustc-link-lib=bcrypt");
        println!("cargo:rustc-link-lib=advapi32");
        println!("cargo:rustc-link-lib=userenv");
    }
    // linux-gnu: libc / libpthread / libdl 由 rustc 默认链接，无需额外声明
}
