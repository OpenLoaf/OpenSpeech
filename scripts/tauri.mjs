#!/usr/bin/env node
// `bun tauri <subcmd>` 的薄包装：
//   - dev 子命令自动塞 --config tauri.dev.conf.json，identifier 切到 com.openspeech.app.dev，
//     数据目录跟 prod / dmg 安装版彻底隔离。
//   - 其它子命令（build / icon / signer ...）原样透传，CI 行为不变。
//   - 已经显式带了 --config 的不重复加。
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const sub = args[0];
const hasConfig = args.some((a) => a === "--config" || a.startsWith("--config="));

const finalArgs = [...args];
if (sub === "dev" && !hasConfig) {
  finalArgs.splice(1, 0, "--config", "src-tauri/tauri.dev.conf.json");
}

const here = dirname(fileURLToPath(import.meta.url));
// Windows pnpm 装的是 tauri.cmd shim，裸 `tauri` 无扩展名 spawn 直接 ENOENT；
// 必须选 .cmd 文件并 shell:true 让 cmd.exe 解析。
const isWin = process.platform === "win32";
const tauriBin = resolve(
  here,
  "..",
  "node_modules",
  ".bin",
  isWin ? "tauri.cmd" : "tauri",
);

const child = spawn(tauriBin, finalArgs, { stdio: "inherit", shell: isWin });
child.on("exit", (code) => process.exit(code ?? 1));
