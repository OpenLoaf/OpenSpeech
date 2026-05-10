use std::fs;
use std::path::PathBuf;

fn main() {
    // 把 openloaf-saas crate 当前 pin 的版本号烤进可执行文件，About 页 dev build
    // 直接读 env!()，不必走 cargo metadata / 运行时解析。Cargo.toml 改了就 rerun。
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let toml_path = manifest_dir.join("Cargo.toml");
    println!("cargo:rerun-if-changed={}", toml_path.display());

    let toml = fs::read_to_string(&toml_path).expect("read Cargo.toml");
    let version = toml
        .lines()
        .find_map(|line| {
            let trimmed = line.trim_start();
            // 仅匹配简单形式 `openloaf-saas = "x.y.z"`；改为 inline-table（含
            // features 等）后须扩展到 `openloaf-saas = { version = "x" ... }`。
            if trimmed.starts_with("openloaf-saas ")
                || trimmed.starts_with("openloaf-saas=")
            {
                trimmed.split('"').nth(1).map(str::to_owned)
            } else {
                None
            }
        })
        .expect("openloaf-saas version not found in Cargo.toml");
    println!("cargo:rustc-env=OPENLOAF_SAAS_SDK_VERSION={version}");

    tauri_build::build()
}
