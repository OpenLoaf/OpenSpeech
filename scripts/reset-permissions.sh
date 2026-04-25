#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ID="com.openspeech.app"
APP_NAME="OpenSpeech"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[reset-permissions] 仅支持 macOS，已跳过。"
  exit 0
fi

if pgrep -f "/MacOS/${APP_NAME}$" >/dev/null 2>&1; then
  echo "[reset-permissions] 检测到 ${APP_NAME}.app 正在运行，先尝试退出..."
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
  sleep 1
  pkill -f "/MacOS/${APP_NAME}$" 2>/dev/null || true
fi

SERVICES=(
  Microphone
  Accessibility
  ListenEvent
  PostEvent
  AppleEvents
  ScreenCapture
  SystemPolicyAllFiles
  SystemPolicyDocumentsFolder
  SystemPolicyDownloadsFolder
  SystemPolicyDesktopFolder
  Camera
  AudioCapture
  Calendar
  Reminders
  AddressBook
  Photos
  MediaLibrary
  Siri
  Motion
  Willow
  FileProviderDomain
  FileProviderPresence
)

echo "[reset-permissions] 重置 ${BUNDLE_ID} 的所有 TCC 权限..."
for svc in "${SERVICES[@]}"; do
  if out=$(tccutil reset "${svc}" "${BUNDLE_ID}" 2>&1); then
    echo "  ✓ ${svc}"
  else
    if [[ "${out}" == *"unknown"* || "${out}" == *"Unknown"* || "${out}" == *"No such"* ]]; then
      :
    else
      echo "  ✗ ${svc}: ${out}"
    fi
  fi
done

echo "[reset-permissions] 完成。下次启动 ${APP_NAME} 会重新申请权限。"
