#!/usr/bin/env bash
# OpenSpeech 前端构建 wrapper（Tauri 用的 ./dist 由本脚本协调产生）。
# - 本地有 src/（OpenSpeech-Frontend 私仓 clone）：走 src/ 自带的 vite multi-entry
#   build，把产物 cp 到公开仓根的 ./dist
# - 外人 clone 公开仓时 src/ 不存在：从 @openloaf/openspeech-frontend npm 包里
#   解出预 build 的 dist
set -euo pipefail
cd "$(dirname "$0")/.."

mode=${1:?Usage: frontend.sh <dev|build>}
pkg_dist="node_modules/@openloaf/openspeech-frontend/dist"

if [ -f src/main.tsx ]; then
  case "$mode" in
    dev)
      # src 私仓自己的 vite dev server 已配 port=1420，Tauri webview 直连
      cd src && exec pnpm exec vite
      ;;
    build)
      (cd src && pnpm exec vite build)
      rm -rf dist
      cp -R src/dist dist
      echo "==> 已从私仓 src/dist 复制 → ./dist"
      ;;
    *)
      echo "unknown mode: $mode" >&2; exit 1
      ;;
  esac
  exit 0
fi

if [ ! -d "$pkg_dist" ]; then
  echo "ERROR: $pkg_dist 不存在；先跑 'pnpm install' 拉取 @openloaf/openspeech-frontend" >&2
  exit 1
fi

case "$mode" in
  build)
    rm -rf dist
    cp -R "$pkg_dist" dist
    echo "==> 已从 @openloaf/openspeech-frontend 复制预构建 dist → ./dist"
    ;;
  dev)
    # 没源码无法 hmr，起静态预览顶替
    exec pnpm exec vite preview --outDir "$pkg_dist" --port 1420 --strictPort
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
