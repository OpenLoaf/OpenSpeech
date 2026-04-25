// 系统权限的 invoke 封装。
//
// **职责分布（v2）**：
//   - **检测（check_*）**：走我们自己的 invoke `permission_check_*`，返回精细
//     5 值状态（granted / denied / notDetermined / restricted / unknown）。UI 文案
//     需要区分 notDetermined（"请求授权"）vs denied（"去系统设置"）。
//   - **请求 麦克风 / 辅助功能（request_*）**：直接调 `tauri-plugin-macos-permissions-api`
//     暴露的 `requestMicrophonePermission` / `requestAccessibilityPermission`
//     （plugin 内部用 Apple 官方 API + macos-accessibility-client，比我们之前的
//     cpal probe / objc 0.2 hack 更稳）。
//   - **请求 输入监控（requestInputMonitoring）**：plugin 的对应命令只 open settings，
//     不调 IOHIDRequestAccess（无法写入「输入监控」列表）。所以这一条仍走我们自己的
//     `permission_request_input_monitoring`（IOHIDRequestAccess）。
//   - **TCC 重置 + open settings**：plugin 不暴露，走我们自己的命令。
//
// macOS 之外的平台没有等价"未授权"概念，check_* 一律返回 "granted"，request_* 静默 no-op。

import { invoke } from "@tauri-apps/api/core";
import {
  requestMicrophonePermission as pluginRequestMicrophone,
  requestAccessibilityPermission as pluginRequestAccessibility,
} from "tauri-plugin-macos-permissions-api";

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

// 麦克风：plugin 调 `[AVCaptureDevice requestAccessForMediaType:soun completionHandler:NULL]`，
// Apple 官方推荐的 API，比 cpal 起 stream 更轻、副作用更小。
export const requestMicrophone = () => pluginRequestMicrophone();

// 输入监控：plugin 不调 IOHIDRequestAccess（它只 open settings，无法把 App 写入列表），
// 所以走我们自己的命令。
export const requestInputMonitoring = () =>
  invoke<void>("permission_request_input_monitoring");

// 辅助功能：plugin 用 macos-accessibility-client 的 `application_is_trusted_with_prompt()`
// 即 `AXIsProcessTrustedWithOptions(prompt=YES)`——把 App 写入「辅助功能」列表的唯一
// 用户态 API。仅查询的 AXIsProcessTrusted 不会注册条目。
export const requestAccessibility = () => pluginRequestAccessibility();

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
