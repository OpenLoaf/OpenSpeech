#!/usr/bin/env node
// 被 `pnpm version <bump>` 通过 npm lifecycle hook 触发：读 package.json.version
// 写回 src-tauri/Cargo.toml 的 [package] version 与 Cargo.lock 里 openspeech 自身
// 的 [[package]] 条目，保证三处一致。tauri.conf.json 已用 "../package.json" 自动跟随。
//
// Cargo.lock 也要改：cargo 在 build 时会把 lock 里本 crate 的 version 改成 Cargo.toml
// 的值，不同步就会在 CI 里产生 lock 漂移（0.2.51 / 0.2.52 两版都是发完才手补一个
// commit 再重打 tag）。
//
// 用 sed 级别的最小替换：Cargo.toml 只改 [package] 段首个 version = "x.y.z" 字面量，
// 避免误碰 dependencies 表里的 version 字段；Cargo.lock 只改 name = "openspeech"
// 紧邻的那行 version。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`[sync-version] invalid semver in package.json: ${version}`);
  process.exit(1);
}

const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");

// 匹配第一个出现在 [package] 段内的 version = "..." — Cargo.toml 约定 [package]
// 是文件顶部第一个 section。非贪婪匹配跳过 name 等中间字段直达首个 version。
const re = /(\[package\][\s\S]*?\nversion\s*=\s*)"([^"]+)"/;
const m = cargo.match(re);
if (!m) {
  console.error("[sync-version] failed to locate [package] version in Cargo.toml");
  process.exit(1);
}
if (m[2] === version) {
  console.log(`[sync-version] Cargo.toml already at ${version}; skip`);
} else {
  writeFileSync(cargoPath, cargo.replace(re, `$1"${version}"`));
  console.log(`[sync-version] Cargo.toml [package] version ${m[2]} → ${version}`);
}

const lockPath = resolve(root, "src-tauri/Cargo.lock");
const lock = readFileSync(lockPath, "utf8");
const lockRe = /(\[\[package\]\]\r?\nname = "openspeech"\r?\nversion = )"([^"]+)"/;
const lm = lock.match(lockRe);
if (!lm) {
  console.error("[sync-version] failed to locate openspeech entry in Cargo.lock");
  process.exit(1);
}
if (lm[2] === version) {
  console.log(`[sync-version] Cargo.lock already at ${version}; skip`);
} else {
  writeFileSync(lockPath, lock.replace(lockRe, `$1"${version}"`));
  console.log(`[sync-version] Cargo.lock openspeech version ${lm[2]} → ${version}`);
}
