#!/usr/bin/env bash
# OpenSpeech 前端构建 wrapper。
# - 本地有 src/（OpenSpeech-Frontend 私仓 clone）：走 vite，hmr / multi-entry 全开
# - 外人 clone 公开仓时 src/ 不存在：用 @openloaf/openspeech-frontend npm 包里的预 build dist
set -euo pipefail
cd "$(dirname "$0")/.."

mode=${1:?Usage: frontend.sh <dev|build>}
pkg_dist="node_modules/@openloaf/openspeech-frontend/dist"

if [ -f src/main.tsx ]; then
  case "$mode" in
    dev)   exec pnpm exec vite ;;
    build) exec pnpm exec vite build ;;
    *)     echo "unknown mode: $mode" >&2; exit 1 ;;
  esac
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
