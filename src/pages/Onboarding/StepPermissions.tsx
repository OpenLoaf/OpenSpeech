import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  Mic,
  Keyboard,
  RefreshCw,
  RotateCw,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { detectPlatform, type Platform } from "@/lib/platform";
import {
  checkPermission,
  openSystemSettings,
  relaunchApp,
  requestAccessibility,
  requestMicrophone,
  requestInputMonitoring,
  resetTccPermissionOne,
  type PermissionKind,
  type PermissionStatus,
  type PermissionUiStatus,
} from "@/lib/permissions";

// Step 2：实测系统权限。
// macOS 上每张卡片对应一个真 Rust 检测（AVCaptureDevice / AXIsProcessTrusted
// / IOHIDCheckAccess）；Windows / Linux 后端直接返回 "granted"（没有等价概念，
// cpal / rdev 自然走通）。
//
// 自动检测时机：
// 1) 组件挂载时立即跑一次
// 2) 应用窗口重新获焦时再跑一次（用户去系统设置勾选后切回应用，这一步把
//    UI 同步到最新）
//
// "授权"按钮逻辑：
//   - 麦克风 notDetermined → 调 cpal probe 触发系统弹窗
//   - 输入监控 notDetermined → 调 IOHIDRequestAccess 触发系统弹窗
//   - 辅助功能 / 上述任意 denied → 直接打开系统设置面板
// 检测结果会在用户切回应用时自动更新；旁边手动"重新检测"按钮兜底。

type CardId = "microphone" | "accessibility" | "input-monitoring" | "inject-tools";

type PermissionCard = {
  id: CardId;
  /** 对应 Rust 检测；null 表示该卡只是说明，不参与检测（如 inject-tools）。 */
  permission: PermissionKind | null;
  icon: typeof Mic;
  title: string;
  rationale: string;
  systemTermHint?: string;
  required: boolean;
};

type TFn = (key: string) => string;

function cardsForPlatform(platform: Platform, t: TFn): PermissionCard[] {
  if (platform === "macos") {
    return [
      {
        id: "microphone",
        permission: "microphone",
        icon: Mic,
        title: t("onboarding:permissions.mic.title"),
        rationale: t("onboarding:permissions.mic.rationale"),
        systemTermHint: t("onboarding:permissions.mic.hint_macos"),
        required: true,
      },
      {
        id: "accessibility",
        permission: "accessibility",
        icon: Keyboard,
        title: t("onboarding:permissions.accessibility.title"),
        rationale: t("onboarding:permissions.accessibility.rationale"),
        systemTermHint: t("onboarding:permissions.accessibility.hint_macos"),
        required: true,
      },
      {
        id: "input-monitoring",
        permission: "input-monitoring",
        icon: KeyRound,
        title: t("onboarding:permissions.input_monitoring.title"),
        rationale: t("onboarding:permissions.input_monitoring.rationale"),
        systemTermHint: t("onboarding:permissions.input_monitoring.hint_macos"),
        required: true,
      },
    ];
  }
  if (platform === "windows") {
    return [
      {
        id: "microphone",
        permission: "microphone",
        icon: Mic,
        title: t("onboarding:permissions.mic.title"),
        rationale: t("onboarding:permissions.mic.rationale"),
        systemTermHint: t("onboarding:permissions.mic.hint_windows"),
        required: true,
      },
      {
        id: "inject-tools",
        permission: null,
        icon: Wrench,
        title: t("onboarding:permissions.inject_tools.title_windows"),
        rationale: t("onboarding:permissions.inject_tools.rationale_windows"),
        required: false,
      },
    ];
  }
  return [
    {
      id: "microphone",
      permission: "microphone",
      icon: Mic,
      title: t("onboarding:permissions.mic.title_linux"),
      rationale: t("onboarding:permissions.mic.rationale_linux"),
      required: true,
    },
    {
      id: "inject-tools",
      permission: null,
      icon: Wrench,
      title: t("onboarding:permissions.inject_tools.title_linux"),
      rationale: t("onboarding:permissions.inject_tools.rationale_linux"),
      required: true,
    },
  ];
}

function headerSummary(platform: Platform, t: TFn): string {
  if (platform === "macos") return t("onboarding:permissions.summary_macos");
  if (platform === "windows") return t("onboarding:permissions.summary_windows");
  return t("onboarding:permissions.summary_linux");
}

function PermissionRow({
  card,
  index,
  status,
  busy,
  onPrimary,
  onRecheck,
}: {
  card: PermissionCard;
  index: number;
  status: PermissionUiStatus;
  busy: boolean;
  onPrimary: () => void;
  onRecheck: () => void;
}) {
  const { t } = useTranslation();
  const granted = status === "granted";
  const denied =
    status === "denied" || status === "restricted" || status === "unknown";
  const notDetermined = status === "notDetermined";
  const checking = status === "checking";
  const isInfoOnly = card.permission === null;

  const primaryLabel = (() => {
    if (isInfoOnly) return t("onboarding:permissions.primary_acknowledged");
    if (denied) return t("onboarding:permissions.primary_open_settings");
    if (notDetermined) {
      // 麦克风 / 输入监控可触发系统弹窗；辅助功能必须打开系统设置手动勾选。
      if (card.permission === "accessibility")
        return t("onboarding:permissions.primary_open_settings");
      return t("onboarding:permissions.primary_request");
    }
    return t("onboarding:permissions.primary_grant");
  })();

  return (
    <div
      className={cn(
        "flex flex-row items-center gap-4 border bg-te-surface px-5 py-3 transition-colors",
        granted
          ? "border-te-accent/60"
          : denied
            ? "border-te-accent/40 bg-te-accent/5"
            : "border-te-gray/60",
      )}
    >
      <div
        className={cn(
          "flex size-12 shrink-0 items-center justify-center border font-mono text-xl font-bold",
          granted
            ? "border-te-accent text-te-accent"
            : denied
              ? "border-te-accent/60 text-te-accent"
              : "border-te-gray text-te-light-gray",
        )}
      >
        {granted ? (
          <Check className="size-6" />
        ) : denied ? (
          <X className="size-5" />
        ) : (
          index
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold uppercase tracking-[0.15em] text-te-fg">
            {card.title}
          </span>
          {card.required ? (
            <span className="shrink-0 border border-te-accent/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-accent">
              {t("onboarding:permissions.badge_required")}
            </span>
          ) : (
            <span className="shrink-0 border border-te-gray/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("onboarding:permissions.badge_recommended")}
            </span>
          )}
        </div>
        {card.systemTermHint ? (
          <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-te-light-gray">
            {card.systemTermHint}
          </p>
        ) : null}
        {/* TCC 与 ad-hoc 签名身份耦合：dev 反复重编 / 无稳定 Developer ID 会让旧条目作废。
            自助路径：从系统设置该权限列表里移除 OpenSpeech 后重新加入，再点「重启 OpenSpeech」。 */}
        {!granted &&
        (card.permission === "accessibility" ||
          card.permission === "input-monitoring") ? (
          <p className="mt-0.5 inline-flex items-start gap-1.5 font-sans text-[11px] leading-snug text-te-light-gray/80">
            <AlertCircle className="mt-0.5 size-3 shrink-0 text-te-accent" />
            <span>{t("onboarding:permissions.tcc_hint")}</span>
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {checking ? (
          <span className="inline-flex items-center gap-2 border border-te-gray/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
            <Loader2 className="size-3.5 animate-spin" />{" "}
            {t("onboarding:permissions.status_checking")}
          </span>
        ) : granted ? (
          <span className="inline-flex items-center gap-2 border border-te-accent px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-accent">
            <Check className="size-3.5" />{" "}
            {t("onboarding:permissions.status_granted")}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={onPrimary}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-2 border px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.2em] transition-colors",
                busy
                  ? "cursor-wait border-te-gray/40 text-te-light-gray/50"
                  : "border-te-accent bg-te-accent text-te-accent-fg hover:bg-te-accent/90",
              )}
            >
              {primaryLabel}
              {!isInfoOnly && (denied || notDetermined) ? (
                <ExternalLink className="size-3.5" />
              ) : null}
            </button>
            {!isInfoOnly ? (
              <button
                type="button"
                onClick={onRecheck}
                disabled={busy}
                className="inline-flex items-center gap-1 border border-te-gray px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-fg hover:text-te-fg disabled:cursor-wait disabled:opacity-50"
                title={t("onboarding:permissions.recheck_one_title")}
              >
                <RefreshCw className="size-3" />
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function StepPermissions({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const platform = detectPlatform();
  const cards = useMemo(() => cardsForPlatform(platform, t), [platform, t]);

  // 信息卡（无 permission）默认 granted，让 allRequiredOk 不会卡住推荐项 / inject-tools；
  // 真权限卡初始 idle，挂载后立即触发首次检测。
  const [statuses, setStatuses] = useState<Record<CardId, PermissionUiStatus>>(
    () =>
      cards.reduce(
        (acc, c) => ({ ...acc, [c.id]: c.permission === null ? "granted" : "idle" }),
        {} as Record<CardId, PermissionUiStatus>,
      ),
  );
  const [busyIds, setBusyIds] = useState<Record<CardId, boolean>>(
    () => cards.reduce((acc, c) => ({ ...acc, [c.id]: false }), {} as Record<CardId, boolean>),
  );

  const setStatus = useCallback(
    (id: CardId, s: PermissionUiStatus) =>
      setStatuses((prev) => ({ ...prev, [id]: s })),
    [],
  );
  const setBusy = useCallback(
    (id: CardId, b: boolean) =>
      setBusyIds((prev) => ({ ...prev, [id]: b })),
    [],
  );

  // 检测某一张卡的真状态。检测期间保持 busy（防止重复点）；结果直接覆盖。
  const recheck = useCallback(
    async (card: PermissionCard) => {
      if (!card.permission) return;
      setStatus(card.id, "checking");
      try {
        const s: PermissionStatus = await checkPermission(card.permission);
        setStatus(card.id, s);
      } catch (e) {
        console.warn("[onboarding] permission check failed:", card.id, e);
        setStatus(card.id, "unknown");
      }
    },
    [setStatus],
  );

  // 全量重检：用 ref 持有最新 cards，避免外部依赖刷新。
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const recheckAll = useCallback(async () => {
    await Promise.all(
      cardsRef.current
        .filter((c) => c.permission !== null)
        .map((c) => recheck(c)),
    );
  }, [recheck]);

  // 挂载时立即检测
  useEffect(() => {
    void recheckAll();
  }, [recheckAll]);

  // 挂载时主动 fire 三个权限的 request——把 App 注册到系统设置列表 + 让用户
  // 顺序看到三个弹框。**macOS 系统弹框天然 queue**：当前的关掉才显示下一个，
  // 不会同时三个堆叠，所以三个 fire-and-forget 即可，不必手动串行。
  //
  // - 麦克风：plugin 调 `[AVCaptureDevice requestAccessForMediaType:soun]`（Apple 官方）
  // - 辅助功能：plugin 调 `AXIsProcessTrustedWithOptions(prompt=YES)`
  // - 输入监控：我们自己的 IOHIDRequestAccess（plugin 不暴露这个 API）
  //
  // **配套短轮询**：macOS 系统弹框（sheet 风格）关闭时**不一定触发** WebView
  // 的 focus 事件，单靠 focus 监听会让"用户允许后 UI 仍显示未授权"（这是
  // 之前的核心 bug）。这里启动 800ms 间隔的轮询，调 check_* 写回 statuses，
  // 直到所有必需项 granted 或 30 次（24s）到顶。idempotent + 自我清理。
  useEffect(() => {
    if (platform !== "macos") return;
    let cancelled = false;

    // 三个 request 一次性 fire-and-forget。已 granted / denied 时系统 no-op；
    // 仅 notDetermined 时弹框；macOS 内部排队，不会同时弹三个。
    void logWarn("[onboarding] mount: auto-request Mic/AX/IM");
    void requestMicrophone()
      .then(() => logWarn("[onboarding] auto-request Microphone OK"))
      .catch((e) =>
        logWarn(`[onboarding] auto-request Microphone failed: ${String(e)}`),
      );
    void requestAccessibility()
      .then(() => logWarn("[onboarding] auto-request Accessibility OK"))
      .catch((e) =>
        logWarn(`[onboarding] auto-request Accessibility failed: ${String(e)}`),
      );
    void requestInputMonitoring()
      .then(() => logWarn("[onboarding] auto-register IM (IOHIDRequestAccess) OK"))
      .catch((e) =>
        logWarn(`[onboarding] auto-register IM failed: ${String(e)}`),
      );

    let ticks = 0;
    const interval = window.setInterval(async () => {
      if (cancelled) return;
      ticks += 1;
      const required = cardsRef.current.filter(
        (c) => c.required && c.permission !== null,
      );
      const results = await Promise.all(
        required.map((c) =>
          checkPermission(c.permission as PermissionKind).catch(() => "unknown"),
        ),
      );
      if (cancelled) return;
      required.forEach((c, i) =>
        setStatus(c.id, results[i] as PermissionStatus),
      );
      if (results.every((s) => s === "granted") || ticks >= 30) {
        window.clearInterval(interval);
      }
    }, 800);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [platform, setStatus]);

  // 进入即检测：若所有必需权限都已是 granted（多半是用户重启后再次进入引导），
  // 直接 onNext()，不在权限页停留。这一组检查独立于 recheckAll → React state 的
  // 异步链路，直接走 Rust 命令拿到精确结果再决定是否跳过；UI 上的 recheckAll 仍
  // 同步推进让"未跳过"的场景看到检测态。
  const autoAdvancedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const required = cardsRef.current.filter(
        (c) => c.required && c.permission !== null,
      );
      const results = await Promise.all(
        required.map((c) =>
          checkPermission(c.permission as PermissionKind).catch(() => "unknown"),
        ),
      );
      if (cancelled || autoAdvancedRef.current) return;
      if (results.every((s) => s === "granted")) {
        autoAdvancedRef.current = true;
        onNext();
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅在挂载时跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 窗口 focus 回到应用时（用户去系统设置勾选完切回来）刷新一遍。
  // Tauri WebviewWindow 的 onFocusChanged 在 webview 进焦时也触发；与浏览器
  // window.focus 事件叠加监听，覆盖 dev / 生产两种 Web 容器行为差异。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const onFocus = () => {
      void recheckAll();
    };
    window.addEventListener("focus", onFocus);

    void getCurrentWebviewWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) void recheckAll();
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
  }, [recheckAll]);

  // 主按钮：
  // - 信息卡 → 直接标 granted（用户确认知晓即可）
  // - 真权限卡：
  //   1. **denied 状态先 reset 一次该项 TCC 条目**——macOS 一旦记录"用户拒绝过"，
  //      之后所有 IOHIDRequestAccess / AXIsProcessTrustedWithOptions 都会被静默
  //      no-op：不弹框、不重写列表。dev / ad-hoc 签名漂移也表现为 denied。
  //      不 reset 直接 request 等于点一个空按钮——这就是用户报"列表里没有
  //      OpenSpeech"的根源。
  //   2. 再调 request_*（idempotent，把 OpenSpeech 写入系统设置的隐私权限列表；
  //      不调的话用户打开系统设置时根本看不到这一条 App 可以勾选）。
  //   3. 最后 open_settings 把对应面板带到前台让用户勾选。
  const onPrimary = useCallback(
    async (card: PermissionCard) => {
      if (!card.permission) {
        setStatus(card.id, "granted");
        return;
      }
      setBusy(card.id, true);
      try {
        const currentStatus = statuses[card.id];
        void logWarn(
          `[onboarding] onPrimary kind=${card.permission} status=${currentStatus}`,
        );
        // 1. denied 路径：先精细 reset 该项的 TCC 条目，让后续 request 能真生效。
        //    notDetermined / restricted / unknown 不 reset——前者是首次接触，
        //    后者是 MDM/系统层限制，reset 帮不上忙也无副作用价值。
        if (currentStatus === "denied") {
          void logWarn(
            `[onboarding] onPrimary: reset TCC for ${card.permission}`,
          );
          await resetTccPermissionOne(card.permission);
        }
        // 2. request：把 App 写入系统设置的隐私列表 + 触发可能的系统弹窗。
        if (card.permission === "microphone") {
          await requestMicrophone();
          void logWarn("[onboarding] onPrimary: requestMicrophone done");
        } else if (card.permission === "input-monitoring") {
          await requestInputMonitoring();
          void logWarn(
            "[onboarding] onPrimary: requestInputMonitoring done",
          );
        } else if (card.permission === "accessibility") {
          await requestAccessibility();
          void logWarn("[onboarding] onPrimary: requestAccessibility done");
        }
        // 3. 打开系统设置面板，让用户在已经显示的 App 行上勾选开关。
        await openSystemSettings(card.permission);
        void logWarn(
          `[onboarding] onPrimary: openSystemSettings(${card.permission}) done`,
        );
        // 触发 / 打开后稍等一拍再检测，让系统授权状态有时间落到 API 层。
        // 用户在系统设置勾选完切回应用时还会再触发一次 recheckAll。
        window.setTimeout(() => {
          void recheck(card);
        }, 600);
      } catch (e) {
        void logWarn(
          `[onboarding] permission action failed: ${card.id} ${String(e)}`,
        );
      } finally {
        setBusy(card.id, false);
      }
    },
    [statuses, setBusy, setStatus, recheck],
  );

  const allRequiredOk = cards.every(
    (c) => !c.required || statuses[c.id] === "granted",
  );

  const platformLabel =
    platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden px-8 pt-16 pb-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex h-full w-full max-w-2xl flex-col gap-3"
      >
        {/* Hero：从原 StepWelcome 搬过来——开门见山亮出产品定位，再过渡到权限授权。 */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em]">
            <span className="text-te-light-gray">
              {t("onboarding:welcome.tag")}
            </span>
            <img
              src="/logo-write.png"
              alt=""
              aria-hidden
              className="size-4 shrink-0 select-none"
              draggable={false}
            />
            <span className="font-bold tracking-[0.25em]">
              <span className="text-te-fg">OPEN</span>
              <span className="text-te-accent">SPEECH</span>
            </span>
          </div>
          <h1 className="font-mono text-[clamp(1.75rem,4.5vw,3rem)] font-bold leading-[0.95] tracking-tighter text-te-fg">
            {t("onboarding:welcome.headline_part1")}
            <span className="text-te-accent">
              {t("onboarding:welcome.headline_part2")}
            </span>
          </h1>
          <p className="max-w-xl font-sans text-xs leading-relaxed text-te-light-gray">
            {t("onboarding:welcome.subhead")}
          </p>
        </div>

        {/* 权限分区头部：标号 + 标题 + 副文。与 hero 之间留较大间距，让 hero 单独成块。 */}
        <div className="mt-10 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
            {t("onboarding:permissions.section_tag", { platform: platformLabel })}
          </span>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-mono text-lg font-bold tracking-tighter text-te-fg md:text-xl">
              {platform === "macos"
                ? t("onboarding:permissions.title_macos")
                : platform === "windows"
                  ? t("onboarding:permissions.title_windows")
                  : t("onboarding:permissions.title_linux")}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void recheckAll()}
                className="inline-flex items-center gap-2 border border-te-gray/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
                title={t("onboarding:permissions.recheck_all_title")}
              >
                <RefreshCw className="size-3" />{" "}
                {t("onboarding:permissions.recheck_all")}
              </button>
            </div>
          </div>
          <p className="font-sans text-xs leading-snug text-te-light-gray">
            {headerSummary(platform, t)}
          </p>
        </div>

        {/* 卡片只占自然高度；底部主按钮通过 `mt-auto` 推到与 Step 1 一致的位置。 */}
        <div className="flex flex-col gap-3">
          {cards.map((card, idx) => (
            <PermissionRow
              key={card.id}
              card={card}
              index={idx + 1}
              status={statuses[card.id]}
              busy={busyIds[card.id]}
              onPrimary={() => void onPrimary(card)}
              onRecheck={() => void recheck(card)}
            />
          ))}
        </div>

        {/* 主按钮居中。Step 1 没有"上一步"。 */}
        <div className="mt-auto flex flex-col items-center gap-2">
          {/* 主 CTA：所有必需权限到位 → 下一步；否则就是"重启 OpenSpeech"——
              进程内 TCC 缓存只有重启才会刷新，重启后再次进入会直接跳过本页。 */}
          <button
            type="button"
            onClick={() =>
              allRequiredOk ? onNext() : void relaunchApp()
            }
            className="group inline-flex items-center gap-3 border border-te-accent bg-te-accent px-6 py-2.5 font-mono text-sm font-bold uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            <span>
              {allRequiredOk
                ? t("onboarding:permissions.footer_next")
                : t("onboarding:permissions.footer_relaunch")}
            </span>
            {allRequiredOk ? (
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            ) : (
              <RotateCw className="size-4" />
            )}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
            {allRequiredOk
              ? t("onboarding:permissions.footer_hint_ok")
              : t("onboarding:permissions.footer_hint_relaunch")}
          </span>
        </div>
      </motion.div>
    </div>
  );
}
