// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 本地语音识别推理子进程：同一个二进制带开关启动，不初始化 Tauri。
    if std::env::args().nth(1).as_deref() == Some(openspeech_lib::LOCAL_ASR_HOST_ARG) {
        std::process::exit(openspeech_lib::run_local_asr_host());
    }
    openspeech_lib::run()
}
