/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// 公开仓 vite 配置：只编 landing.html（公网落地页），产出到 dist-landing/。
// app 本体（main + promo）已经迁出到 @openloaf/openspeech-frontend npm 包，
// 由 scripts/frontend.sh 统一协调到 ./dist 供 Tauri 消费，跟此处的 landing
// 产物完全隔离。
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist-landing",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: path.resolve(__dirname, "landing.html"),
      },
    },
  },
  // landing dev 走 1421，避开 1420（Tauri webview / src 私仓 vite 占用），
  // 允许 `pnpm dev`（landing）和 `pnpm tauri:dev`（app 本体）同机并行。
  server: {
    port: 1421,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["landing/**/*.{test,spec}.{ts,tsx}"],
  },
}));
