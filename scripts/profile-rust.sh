#!/usr/bin/env bash
# 用 dev-style cargo profile (`profiling`) 重 build，组装成独立 Bundle ID 的 .app，
# samply launch 录制 Rust 性能 profile。
#
# 关键设计：
# 1. profile.profiling = dev + opt-level=1 + frame-pointers (默认存在) + debug-assertions=false。
#    debug-assertions=false 让 Tauri 走"production"分支，把 dist/ 嵌入而不是连 localhost:1420。
# 2. opt-level=1：opt-level=0 太慢导致音频/ASR timing 变形，看不到真实瓶颈；
#    opt-level=3 (release) 又把代码 inline 得太厉害让 unwind 不稳。1 是平衡点。
# 3. force-frame-pointers 不需要显式设——dev 风格 profile 默认保留 FP。
# 4. .app 用独立 Bundle ID `com.openspeech.profiling` + 独立显示名，
#    macOS TCC 视为另一个 app，不撞已安装的正式版权限。
# 5. ad-hoc 重签 + get-task-allow entitlement → samply 可以 launch/attach。

set -euo pipefail

BIN_NAME=openspeech                        # cargo 产物名 (来自 Cargo.toml [package].name)
PROF_NAME=OpenSpeechProf
PROF_BUNDLE="/Applications/${PROF_NAME}.app"
ENTITLEMENTS="/tmp/openspeech-profiling.entitlements"
OUT="${1:-/tmp/openspeech-profile.json.gz}"

# 复用现有 release bundle 的 Info.plist + Resources/ + 嵌入资源；
# 只是把里头的二进制换成 profiling profile build 出来的。
SRC_BUNDLE="src-tauri/target/release/bundle/macos/OpenSpeech.app"
TARGET_BIN="src-tauri/target/profiling/${BIN_NAME}"

red() { printf "\033[31m%s\033[0m\n" "$*"; }
grn() { printf "\033[32m%s\033[0m\n" "$*"; }
ylw() { printf "\033[33m%s\033[0m\n" "$*"; }
cyn() { printf "\033[36m%s\033[0m\n" "$*"; }

# ─── 0. 前置依赖 ─────────────────────────────────────────────
command -v samply >/dev/null || { red "✗ samply 未安装：cargo install --locked samply"; exit 1; }
[ -d "$SRC_BUNDLE" ] || { red "✗ 找不到 $SRC_BUNDLE，请先跑 pnpm tauri build 至少一次以生成 Info.plist 模板"; exit 1; }

# ─── 1. 检查前端 dist/ ─────────────────────────────────────
if [ ! -f dist/index.html ]; then
  ylw "→ dist/ 不存在，跑 vite build (跳过 tsc 因 Meetings 页未完成)"
  pnpm exec vite build
fi

# ─── 2. cargo build --profile profiling ─────────────────────
ylw "→ cargo build --profile profiling --features custom-protocol"
# 通过本 crate 的 custom-protocol feature 把 tauri/custom-protocol 透传给 tauri：
# 让 Tauri 走 production 分支 (cfg(dev)=false)，加载嵌入的 dist/ 而非连 localhost:1420。
# 直接 --features tauri/custom-protocol 不行——cargo 不会让透传给 openspeech_lib 自己的 tauri 依赖。
( cd src-tauri && cargo build --profile profiling --features custom-protocol )

[ -x "$TARGET_BIN" ] || { red "✗ 编译产物不存在：$TARGET_BIN"; exit 1; }

# 验证 frame pointer 保留 (otool 输出量大；不 pipe 给 grep 以避 SIGPIPE 触发 pipefail 误报)
ASM_DUMP=$(mktemp)
otool -tv "$TARGET_BIN" 2>/dev/null > "$ASM_DUMP" || true
if grep -q "stp.*x29.*sp" "$ASM_DUMP"; then
  grn "✓ frame pointer 保留 (unwind 可靠)"
else
  ylw "! 未检测到 stp x29 序列；samply unwind 可能仍不准"
fi
rm -f "$ASM_DUMP"

# ─── 3. 关掉旧实例 ─────────────────────────────────────────
if pgrep -x "$PROF_NAME" >/dev/null; then
  pkill -x "$PROF_NAME" 2>/dev/null || true
  sleep 1
fi

# ─── 4. 组装独立 bundle ────────────────────────────────────
ylw "→ 组装 ${PROF_BUNDLE}"
if [ -d "$PROF_BUNDLE" ] && [ ! -w "$PROF_BUNDLE" ]; then
  sudo rm -rf "$PROF_BUNDLE"
  sudo cp -R "$SRC_BUNDLE" "$PROF_BUNDLE"
  sudo chown -R "$(whoami)" "$PROF_BUNDLE"
else
  rm -rf "$PROF_BUNDLE"
  cp -R "$SRC_BUNDLE" "$PROF_BUNDLE"
fi

# 4a. 二进制：覆盖并改名
mv "${PROF_BUNDLE}/Contents/MacOS/${BIN_NAME}" "${PROF_BUNDLE}/Contents/MacOS/_old_release_bin" 2>/dev/null || true
rm -f "${PROF_BUNDLE}/Contents/MacOS/_old_release_bin"
cp "$TARGET_BIN" "${PROF_BUNDLE}/Contents/MacOS/${PROF_NAME}"

# 4b. Info.plist：独立 Bundle ID + 显示名 + Executable 指向新二进制
plutil -replace CFBundleIdentifier  -string "com.openspeech.profiling" "${PROF_BUNDLE}/Contents/Info.plist"
plutil -replace CFBundleName        -string "$PROF_NAME"               "${PROF_BUNDLE}/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "$PROF_NAME"               "${PROF_BUNDLE}/Contents/Info.plist"
plutil -replace CFBundleExecutable  -string "$PROF_NAME"               "${PROF_BUNDLE}/Contents/Info.plist"

# 4c. entitlements：get-task-allow 让 samply 可以 ptrace
cat > "$ENTITLEMENTS" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.get-task-allow</key>
    <true/>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
EOF

# 4d. ad-hoc 重签（注意：不带 --options=runtime → 关闭 hardened runtime → 允许调试）
codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$PROF_BUNDLE" 2>&1 | tail -3

if codesign -d --entitlements - "$PROF_BUNDLE" 2>&1 | grep -q "get-task-allow"; then
  grn "✓ profiling bundle 就绪：$PROF_BUNDLE"
else
  red "✗ entitlements 注入失败"; exit 1
fi

# 4e. 顺便生成 dSYM（atos 离线分析用）
ylw "→ 生成 dSYM (供离线符号化)"
DSYM="/tmp/${PROF_NAME}.dSYM"
rm -rf "$DSYM"
dsymutil "${PROF_BUNDLE}/Contents/MacOS/${PROF_NAME}" -o "$DSYM" 2>&1 | tail -2

# ─── 5. 提示 + 启动 samply ──────────────────────────────────
echo
cyn "=== 即将 launch + record ==="
cyn "输出 trace: $OUT"
cyn "dSYM 位置:  $DSYM"
echo
ylw "首次启动 macOS 会询问麦克风/辅助功能/输入监控权限——全部允许。"
ylw "之后只要不重 build 就一直保留。"
echo
cyn "建议测试动作："
echo "  1. idle 5 秒（基线）"
echo "  2. 按热键 → 持续说 30 秒 → 松开 → 等 AI refine 注入完成"
echo "  3. 立刻再录一次 10 秒（看冷启 vs 热启）"
echo "  4. 打开 History 页滚动几下"
echo "  5. 在本终端按 Ctrl+C 停止录制"
echo

exec samply record --save-only -o "$OUT" "${PROF_BUNDLE}/Contents/MacOS/${PROF_NAME}"
