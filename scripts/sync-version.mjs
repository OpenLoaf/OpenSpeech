#!/usr/bin/env node
// 被 `pnpm version <bump>` 通过 npm lifecycle hook 触发：读 package.json.version
// 写回 src-tauri/Cargo.toml 的 [package] version，保证两处一致。
// tauri.conf.json 已用 "../package.json" 自动跟随，无需手动写。
//
// 用 sed 级别的最小替换：只改 [package] 段首个 version = "x.y.z" 字面量，
// 避免误碰 dependencies 表里的 version 字段。
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
  process.exit(0);
}

const next = cargo.replace(re, `$1"${version}"`);
writeFileSync(cargoPath, next);
console.log(`[sync-version] Cargo.toml [package] version ${m[2]} → ${version}`);
