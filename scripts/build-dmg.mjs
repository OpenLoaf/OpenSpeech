#!/usr/bin/env node
// @ts-nocheck
// 用 appdmg 打 OpenSpeech 的 macOS DMG，绕开 Tauri/cargo-bundle 内置的 AppleScript 路径。
// AppleScript 在 GitHub Actions headless runner 上 silent no-op，导致 .DS_Store 缺失、
// 背景图和图标位置失效。appdmg 直接写 .DS_Store 二进制，CI/本地表现一致。

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import appdmg from 'appdmg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    out: { type: 'string' },
  },
  allowPositionals: true,
});

const rustTarget = values.target ?? 'aarch64-apple-darwin';
const archTag = rustTarget.startsWith('aarch64') ? 'aarch64' : 'x64';
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

const appPath = join(repoRoot, 'src-tauri/target', rustTarget, 'release/bundle/macos/OpenSpeech.app');
const bgPath = join(repoRoot, 'src-tauri/dmg/background.png');
const iconPath = join(repoRoot, 'src-tauri/icons/icon.icns');
const outDir = join(repoRoot, 'src-tauri/target', rustTarget, 'release/bundle/dmg');
const outPath = values.out
  ? resolve(values.out)
  : join(outDir, `OpenSpeech_${version}_${archTag}.dmg`);

mkdirSync(outDir, { recursive: true });

if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
  console.error(`[dmg] OpenSpeech.app 不存在：${appPath}\n请先跑 \`pnpm tauri build --target ${rustTarget}\``);
  process.exit(1);
}
if (!existsSync(bgPath)) {
  console.error(`[dmg] 背景图不存在：${bgPath}`);
  process.exit(1);
}
if (!existsSync(iconPath)) {
  console.error(`[dmg] 卷宗图标不存在：${iconPath}`);
  process.exit(1);
}

// windowSize / appPosition / applicationFolderPosition 与原 tauri.conf.json 的 dmg 段保持一致，
// 这样换打包工具不会改变 DMG 视觉。
const ee = appdmg({
  basepath: repoRoot,
  target: outPath,
  specification: {
    title: 'OpenSpeech',
    icon: iconPath,
    background: bgPath,
    'icon-size': 80,
    window: { size: { width: 540, height: 380 } },
    contents: [
      { x: 140, y: 260, type: 'file', path: appPath },
      { x: 400, y: 260, type: 'link', path: '/Applications' },
    ],
  },
});

ee.on('progress', (info) => {
  if (info.type === 'step-begin') {
    console.log(`[dmg] ${info.current}/${info.total}  ${info.title}`);
  }
});
ee.on('error', (err) => {
  console.error('[dmg] 失败：', err);
  process.exit(1);
});
ee.on('finish', () => {
  console.log(`[dmg] 完成：${outPath}`);
});
