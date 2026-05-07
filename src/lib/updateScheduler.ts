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

// 触发模型：Home 页 mount 即立刻 check 一次，并起 5 分钟轮询。
// 不再以"软件 boot"为时机——bug 多出在那条路径上（用户根本没看到主窗就被弹 toast、
// 网络栈还在初始化、settings 还没就绪等）。Home 页激活意味着用户确实进了主窗界面，
// 时机是干净的；首次激活之后 5 分钟周期跑下去，不再依赖"启动一次性 check"。

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const AUTO_IDLE_THRESHOLD_SECONDS = 5 * 60;
const AUTO_IDLE_POLL_MS = 60_000;

interface SchedulerState {
  policyListenerStarted: boolean;
  homeActivated: boolean;
  checkTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  pendingAutoInstall: { version: string; update: Update } | null;
  autoIdleTimer: ReturnType<typeof setInterval> | null;
}

const state: SchedulerState = {
  policyListenerStarted: false,
  homeActivated: false,
  checkTimer: null,
  inFlight: false,
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

function scheduleNextCheck() {
  clearCheckTimer();
  state.checkTimer = setTimeout(() => {
    void runCheck();
  }, CHECK_INTERVAL_MS);
  void logInfo(
    `[updater] next check scheduled in ${(CHECK_INTERVAL_MS / 60_000).toFixed(0)} min`,
  );
}

async function runCheck(): Promise<void> {
  if (state.inFlight) {
    void logInfo("[updater] tick skipped: another check still in flight");
    return;
  }
  const { updatePolicy, skippedUpdateVersion } =
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
    `[updater] tick=${tickId} START policy=${updatePolicy} skipped=${skippedUpdateVersion || "none"} queued=${alreadyQueued ?? "none"}`,
  );

  state.inFlight = true;
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
    state.inFlight = false;
    scheduleNextCheck();
    return;
  }

  state.inFlight = false;
  const elapsed = Date.now() - startedAt;

  if (!upd) {
    void logInfo(`[updater] tick=${tickId} DONE no-update (${elapsed}ms)`);
    scheduleNextCheck();
    return;
  }

  void logInfo(
    `[updater] tick=${tickId} HIT version=${upd.version} current=${upd.currentVersion} (${elapsed}ms)`,
  );

  if (skippedUpdateVersion && skippedUpdateVersion === upd.version) {
    void logInfo(
      `[updater] tick=${tickId} suppressed: ${upd.version} matches skippedUpdateVersion`,
    );
    scheduleNextCheck();
    return;
  }

  if (alreadyQueued && alreadyQueued === upd.version) {
    void logInfo(
      `[updater] tick=${tickId} no-op: ${upd.version} already queued`,
    );
    scheduleNextCheck();
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

  scheduleNextCheck();
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

// boot 期挂 policy 监听器；不再主动触发首次 check（等 Home 页激活）。
export function startUpdateScheduler(): void {
  if (state.policyListenerStarted) return;
  state.policyListenerStarted = true;
  void logInfo("[updater] policy listener attached, awaiting home activation");

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
      return;
    }
    // 切回 PROMPT/AUTO：仅当 Home 已经激活过才立刻 kick；否则等 Home 激活。
    if (state.homeActivated) {
      void runCheck();
    }
  });
}

// Home 页 mount 即调用：立即检查一次 + 重置 5 分钟轮询。
// 幂等：重复调用会取消上一轮 timer，正在跑的 check 会被 inFlight 守门跳过。
export function notifyHomeActivated(): void {
  state.homeActivated = true;
  void logInfo("[updater] home activated → running immediate check");
  clearCheckTimer();
  void runCheck();
}
