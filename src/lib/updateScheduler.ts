import i18next from "i18next";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import {
  info as logInfo,
  warn as logWarn,
  error as logError,
} from "@tauri-apps/plugin-log";
import { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdateForChannel } from "@/lib/updaterInstall";
import { useRecordingStore } from "@/stores/recording";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";

// 取代 main.tsx 里"启动只 check 一次"的旧逻辑：
//   - boot 触发一次 + 之后按 updateCheckIntervalHours 周期触发；
//   - 命中新版后按 updatePolicy 决定走 toast prompt 还是空闲自动安装；
//   - DISABLED 完全不调度。
//
// 单例化：模块作用域 + 一个进程内全局状态，确保 React StrictMode / HMR 重挂载也不
// 会把 timer 装两份。

const CHECK_TIMEOUT_MS = 30_000;
// AUTO 策略：用户连续 N 秒无键鼠输入才认为"空闲"，避免在用户暂时离开瞬间就重启。
const AUTO_IDLE_THRESHOLD_SECONDS = 5 * 60;
// AUTO 策略下的空闲轮询间隔：每分钟检查一次 idle + 录音状态。
const AUTO_IDLE_POLL_MS = 60_000;
// 检查失败时的快速重试：网络一过可能马上能成；不与正常周期混在一起。
const RETRY_AFTER_FAIL_MS = 30 * 60_000;

interface SchedulerState {
  started: boolean;
  checkTimer: ReturnType<typeof setTimeout> | null;
  // AUTO 策略命中后挂在这里，等空闲 + 非录音中再 install。
  pendingAutoInstall: { version: string; update: Update } | null;
  autoIdleTimer: ReturnType<typeof setInterval> | null;
}

const state: SchedulerState = {
  started: false,
  checkTimer: null,
  pendingAutoInstall: null,
  autoIdleTimer: null,
};

function clearCheckTimer() {
  if (state.checkTimer) {
    clearTimeout(state.checkTimer);
    state.checkTimer = null;
  }
}

function clearAutoIdleTimer() {
  if (state.autoIdleTimer) {
    clearInterval(state.autoIdleTimer);
    state.autoIdleTimer = null;
  }
}

function scheduleNextCheck(delayMs: number) {
  clearCheckTimer();
  const at = new Date(Date.now() + delayMs).toISOString();
  void logInfo(
    `[updater] next check scheduled in ${(delayMs / 60_000).toFixed(1)} min (≈ ${at})`,
  );
  state.checkTimer = setTimeout(() => {
    void runCheck();
  }, delayMs);
}

async function runCheck(): Promise<void> {
  const { updatePolicy, updateCheckIntervalHours, skippedUpdateVersion } =
    useSettingsStore.getState().general;

  const tickId = new Date().toISOString();

  if (updatePolicy === "DISABLED") {
    void logInfo(`[updater] tick=${tickId} skipped: policy=DISABLED`);
    return;
  }

  const alreadyQueued =
    useUIStore.getState().pendingUpdate?.version ??
    state.pendingAutoInstall?.version ??
    null;

  void logInfo(
    `[updater] tick=${tickId} START policy=${updatePolicy} interval=${updateCheckIntervalHours}h skipped=${skippedUpdateVersion || "none"} queued=${alreadyQueued ?? "none"}`,
  );

  const startedAt = Date.now();
  let upd: Update | null = null;
  try {
    upd = await Promise.race([
      checkForUpdateForChannel(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("updater check timeout")), CHECK_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    const elapsed = Date.now() - startedAt;
    void logWarn(
      `[updater] tick=${tickId} FAIL after ${elapsed}ms: ${String((e as Error)?.message ?? e)}`,
    );
    const intervalMs = Math.max(1, updateCheckIntervalHours) * 3600_000;
    scheduleNextCheck(Math.min(RETRY_AFTER_FAIL_MS, intervalMs));
    return;
  }

  const elapsed = Date.now() - startedAt;

  if (!upd) {
    void logInfo(`[updater] tick=${tickId} DONE no-update (${elapsed}ms)`);
    scheduleNextCheck(Math.max(1, updateCheckIntervalHours) * 3600_000);
    return;
  }

  void logInfo(
    `[updater] tick=${tickId} HIT version=${upd.version} current=${upd.currentVersion} (${elapsed}ms)`,
  );

  if (skippedUpdateVersion && skippedUpdateVersion === upd.version) {
    void logInfo(
      `[updater] tick=${tickId} suppressed: ${upd.version} matches skippedUpdateVersion`,
    );
    scheduleNextCheck(Math.max(1, updateCheckIntervalHours) * 3600_000);
    return;
  }

  if (alreadyQueued && alreadyQueued === upd.version) {
    void logInfo(
      `[updater] tick=${tickId} no-op: ${upd.version} already queued`,
    );
    scheduleNextCheck(Math.max(1, updateCheckIntervalHours) * 3600_000);
    return;
  }

  if (updatePolicy === "AUTO") {
    void logInfo(
      `[updater] tick=${tickId} → AUTO queue ${upd.version}, will install on next idle window`,
    );
    state.pendingAutoInstall = { version: upd.version, update: upd };
    ensureAutoIdleTimer();
  } else {
    void logInfo(
      `[updater] tick=${tickId} → PROMPT toast for ${upd.version}`,
    );
    useUIStore
      .getState()
      .setPendingUpdate({ version: upd.version, update: upd });
  }

  scheduleNextCheck(Math.max(1, updateCheckIntervalHours) * 3600_000);
}

function ensureAutoIdleTimer() {
  if (state.autoIdleTimer) return;
  // 立即跑一次再起 interval：boot 后用户已经离开数小时的情形不必再等满一轮。
  void tryAutoInstall();
  state.autoIdleTimer = setInterval(() => {
    void tryAutoInstall();
  }, AUTO_IDLE_POLL_MS);
}

async function tryAutoInstall(): Promise<void> {
  const queued = state.pendingAutoInstall;
  if (!queued) {
    clearAutoIdleTimer();
    return;
  }
  const policy = useSettingsStore.getState().general.updatePolicy;
  if (policy !== "AUTO") {
    void logInfo(
      `[updater] auto-install: policy changed to ${policy}, hand off ${queued.version}`,
    );
    if (policy === "PROMPT") {
      useUIStore
        .getState()
        .setPendingUpdate({ version: queued.version, update: queued.update });
    }
    state.pendingAutoInstall = null;
    clearAutoIdleTimer();
    return;
  }
  const recState = useRecordingStore.getState().state;
  if (recState !== "idle") {
    void logInfo(
      `[updater] auto-install: waiting (recording state=${recState}, version=${queued.version})`,
    );
    return;
  }
  let idleSec: number;
  try {
    idleSec = await invoke<number>("system_idle_seconds");
  } catch (e) {
    void logWarn(
      `[updater] auto-install: idle probe failed (${String((e as Error)?.message ?? e)}), skipping tick`,
    );
    return;
  }
  if (idleSec < AUTO_IDLE_THRESHOLD_SECONDS) {
    void logInfo(
      `[updater] auto-install: idle ${idleSec}s < threshold ${AUTO_IDLE_THRESHOLD_SECONDS}s, waiting (version=${queued.version})`,
    );
    return;
  }
  void logInfo(
    `[updater] auto-install FIRING version=${queued.version} idleSec=${idleSec} threshold=${AUTO_IDLE_THRESHOLD_SECONDS}s`,
  );
  state.pendingAutoInstall = null;
  clearAutoIdleTimer();
  try {
    await silentInstall(queued.update, queued.version);
  } catch (e) {
    void logError(
      `[updater] auto-install failed: ${String((e as Error)?.message ?? e)}`,
    );
    useUIStore
      .getState()
      .setPendingUpdate({ version: queued.version, update: queued.update });
    toast.error(i18next.t("settings:about.install_failed"), {
      description: String((e as Error)?.message ?? e),
    });
  }
}

// AUTO 路径专用：不弹"下载中"toast（用户都不在），只走 download → install → relaunch。
// 失败抛出由 tryAutoInstall 处理。
async function silentInstall(update: Update, version: string): Promise<void> {
  void logInfo(`[updater] silentInstall start → ${version}`);
  await update.downloadAndInstall(undefined, { timeout: 5 * 60 * 1000 });
  void logInfo(`[updater] silentInstall returned, requesting relaunch`);
  await invoke("relaunch_app");
}

export function startUpdateScheduler(): void {
  if (state.started) return;
  state.started = true;
  void logInfo("[updater] scheduler started");
  // 立即跑一次启动检查；后续由 runCheck 自己排下一轮。
  void runCheck();

  // 监听策略变更：从 DISABLED 切回 PROMPT/AUTO 时立刻 kick 一次；切到 DISABLED
  // 取消已排队的自动安装（已弹 toast 的 pendingUpdate 留给用户自己处理）。
  let prevPolicy = useSettingsStore.getState().general.updatePolicy;
  useSettingsStore.subscribe((s) => {
    const next = s.general.updatePolicy;
    if (next === prevPolicy) return;
    void logInfo(`[updater] policy changed ${prevPolicy} → ${next}`);
    prevPolicy = next;
    if (next === "DISABLED") {
      clearCheckTimer();
      clearAutoIdleTimer();
      state.pendingAutoInstall = null;
    } else {
      void runCheck();
    }
  });
}
