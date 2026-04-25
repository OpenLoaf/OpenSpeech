// 系统权限的 invoke 封装。Rust 命令位于 src-tauri/src/permissions/。
// macOS 上是真检测；Windows / Linux 一律返回 "granted"（这两个平台没有等价
// 的"未授权"概念，cpal/rdev 直接尝试即可）。

import { invoke } from "@tauri-apps/api/core";

export type PermissionStatus =
  | "granted"
  | "denied"
  | "notDetermined"
  | "restricted"
  | "unknown";

export type PermissionKind =
  | "microphone"
  | "accessibility"
  | "input-monitoring";

export type PermissionUiStatus =
  | "idle"
  | "checking"
  | PermissionStatus;

export const checkMicrophone = () =>
  invoke<PermissionStatus>("permission_check_microphone");
export const checkAccessibility = () =>
  invoke<PermissionStatus>("permission_check_accessibility");
export const checkInputMonitoring = () =>
  invoke<PermissionStatus>("permission_check_input_monitoring");

export const requestMicrophone = () =>
  invoke<void>("permission_request_microphone");
export const requestInputMonitoring = () =>
  invoke<void>("permission_request_input_monitoring");
// AXIsProcessTrustedWithOptions(prompt=YES)：把 OpenSpeech 写入系统设置
// 「辅助功能」列表的唯一用户态 API。仅查询的 AXIsProcessTrusted 不会注册条目。
export const requestAccessibility = () =>
  invoke<void>("permission_request_accessibility");

export const openSystemSettings = (kind: PermissionKind) =>
  invoke<void>("permission_open_settings", { kind });

// macOS 上 AXIsProcessTrusted / AVCaptureDevice authorizationStatus 是 per-process
// 缓存的：用户在系统设置勾选后，已运行的进程仍读到 not-granted，必须重启进程才能
// 拿到新值。Onboarding 权限页在权限尚未授全时给用户一个"重启 OpenSpeech"按钮。
export const relaunchApp = () => invoke<void>("relaunch_app");

/**
 * macOS 专用恢复操作：清空 OpenSpeech 在 TCC（Accessibility / ListenEvent /
 * Microphone）的所有授权条目。用于"已勾选但仍读不到"的 ad-hoc 签名场景——
 * dev 反复重编 / 没有稳定 Developer ID 的 release 构建都会让签名身份漂移，
 * TCC 旧条目作废却不会自动清除。重置后，下次再打开系统设置授权会按当前签名
 * 身份重新登记，从此一致。其它平台 no-op。
 */
export const resetTccPermissions = () =>
  invoke<void>("permission_reset_tcc");

/**
 * macOS 专用：只 reset 指定的 single service。在 onPrimary 的"去系统设置"
 * 路径里，当 status === "denied" 时调用——清掉旧 deny / 签名漂移条目后，
 * 立即跟一次 `request_*` 让 App 按当前签名重新写入隐私列表，用户在系统
 * 设置里才看得到 OpenSpeech 这一条。其它平台 no-op。
 */
export const resetTccPermissionOne = (kind: PermissionKind) =>
  invoke<void>("permission_reset_tcc_one", { kind });

export async function checkPermission(
  kind: PermissionKind,
): Promise<PermissionStatus> {
  if (kind === "microphone") return checkMicrophone();
  if (kind === "accessibility") return checkAccessibility();
  return checkInputMonitoring();
}
