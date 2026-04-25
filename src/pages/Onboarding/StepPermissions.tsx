import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ExternalLink,
  Eraser,
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
  resetTccPermissions,
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

function cardsForPlatform(platform: Platform): PermissionCard[] {
  if (platform === "macos") {
    return [
      {
        id: "microphone",
        permission: "microphone",
        icon: Mic,
        title: "麦克风",
        rationale: "用于录制你的语音并送到识别引擎。",
        systemTermHint: "授权位置：系统设置 → 隐私与安全性 → 麦克风",
        required: true,
      },
      {
        id: "accessibility",
        permission: "accessibility",
        icon: Keyboard,
        title: "辅助功能",
        rationale: "用于把识别出的文字模拟键盘输入到当前焦点的输入框。",
        systemTermHint: "授权位置：系统设置 → 隐私与安全性 → 辅助功能",
        required: true,
      },
      {
        id: "input-monitoring",
        permission: "input-monitoring",
        icon: KeyRound,
        title: "输入监控",
        rationale:
          "用于在你正在使用其它 App 时，监听全局快捷键（如 Fn / Ctrl+Win）触发录音。",
        systemTermHint: "授权位置：系统设置 → 隐私与安全性 → 输入监控",
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
        title: "麦克风",
        rationale: "用于录制你的语音并送到识别引擎。",
        systemTermHint: "授权位置：Windows 设置 → 隐私 → 麦克风",
        required: true,
      },
      {
        id: "inject-tools",
        permission: null,
        icon: Wrench,
        title: "目标程序权限提示",
        rationale:
          "若你常用的程序以管理员身份运行（如 cmd），OpenSpeech 也需要相同权限才能注入文字。",
        required: false,
      },
    ];
  }
  return [
    {
      id: "microphone",
      permission: "microphone",
      icon: Mic,
      title: "麦克风设备",
      rationale: "Linux 不需要授权弹窗；从 PipeWire / PulseAudio 选一个输入设备即可。",
      required: true,
    },
    {
      id: "inject-tools",
      permission: null,
      icon: Wrench,
      title: "检测注入工具",
      rationale: "Wayland 下需要 ydotool / wtype，X11 下需要 xdotool。OpenSpeech 会自动检测。",
      required: true,
    },
  ];
}

// 头部副标题：把当前平台需要的权限名直接列出来，避免"权限到底是什么"的疑问。
function headerSummary(platform: Platform): string {
  if (platform === "macos") {
    return "macOS 需要三项系统权限：「麦克风」（录音）、「辅助功能」（把转写的文字写到当前 App）、「输入监控」（监听全局快捷键）。系统的权限缓存与进程绑定——若已在系统设置勾选但仍显示未授权，点击右上角「重启 OpenSpeech」让新权限生效。";
  }
  if (platform === "windows") {
    return "Windows 需要授权「麦克风」（用于录音）。若你常用的目标程序以管理员身份运行，OpenSpeech 也需相同权限才能注入文字。";
  }
  return "Linux 不需要授权弹窗：选择一个 PipeWire / PulseAudio 输入设备，并确保安装了 ydotool / wtype（Wayland）或 xdotool（X11）即可。";
}

function statusLabel(s: PermissionUiStatus): string {
  switch (s) {
    case "granted":
      return "已授权";
    case "checking":
      return "检测中";
    case "denied":
      return "未授权";
    case "notDetermined":
      return "尚未授权";
    case "restricted":
      return "系统限制";
    case "unknown":
      return "无法检测";
    default:
      return "—";
  }
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
  const granted = status === "granted";
  const denied =
    status === "denied" || status === "restricted" || status === "unknown";
  const notDetermined = status === "notDetermined";
  const checking = status === "checking";
  const isInfoOnly = card.permission === null;

  const primaryLabel = (() => {
    if (isInfoOnly) return "我已知晓";
    if (denied) return "去系统设置";
    if (notDetermined) {
      // 麦克风 / 输入监控可触发系统弹窗；辅助功能必须打开系统设置手动勾选。
      if (card.permission === "accessibility") return "去系统设置";
      return "请求授权";
    }
    return "授权";
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
              必需
            </span>
          ) : (
            <span className="shrink-0 border border-te-gray/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              推荐
            </span>
          )}
        </div>
        {card.systemTermHint ? (
          <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-te-light-gray">
            {card.systemTermHint}
          </p>
        ) : null}
        {/* macOS Accessibility / Input Monitoring 的检测受 TCC 与 ad-hoc 签名身份耦合
            影响：dev 反复重编 / 没有稳定 Developer ID 的 release 都会让旧签名条目作废。
            两条恢复路径：① 右上角「重置授权记录」（tccutil reset 一键清旧条目）+ 重新
            勾选；② 手动从系统设置该权限列表里移除 OpenSpeech 后重新加入。 */}
        {!granted &&
        (card.permission === "accessibility" ||
          card.permission === "input-monitoring") ? (
          <p className="mt-0.5 inline-flex items-start gap-1.5 font-sans text-[11px] leading-snug text-te-light-gray/80">
            <AlertCircle className="mt-0.5 size-3 shrink-0 text-te-accent" />
            <span>
              已勾选但仍提示未授权？点
              <span className="text-te-fg">「重置授权记录」</span>
              清旧条目后重新勾选，再点「重启 OpenSpeech」。
            </span>
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {checking ? (
          <span className="inline-flex items-center gap-2 border border-te-gray/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
            <Loader2 className="size-3.5 animate-spin" /> 检测中
          </span>
        ) : granted ? (
          <span className="inline-flex items-center gap-2 border border-te-accent px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-accent">
            <Check className="size-3.5" /> 已授权
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
                title="重新检测"
              >
                <RefreshCw className="size-3" />
              </button>
            ) : null}
          </>
        )}
        {!checking && !granted && status !== "idle" ? (
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray md:inline">
            {statusLabel(status)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function StepPermissions({ onNext }: { onNext: () => void }) {
  const platform = detectPlatform();
  const cards = useMemo(() => cardsForPlatform(platform), [platform]);

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

  // 主动把 OpenSpeech 写入 macOS「输入监控」/「辅助功能」列表。
  // 仅 IOHIDCheckAccess / AXIsProcessTrusted 不会注册条目——只有调用 *Request* API
  // 才把 App 登记到系统设置的隐私列表里。否则用户打开系统设置「输入监控」时根本
  // 看不到 OpenSpeech 这一条可勾选项（即图中"列表为空"的现象）。
  // 时机：挂载后先跑一次首检（recheckAll 启动），紧跟着 fire-and-forget 调 request
  // —— 此时 onboarding 已显示，弹出的系统对话框会正常叠在页面之上。
  // idempotent：已 granted / denied 时系统自动 no-op。仅在 macOS 真正未授权时弹框。
  const registeredRef = useRef(false);
  useEffect(() => {
    if (platform !== "macos") return;
    if (registeredRef.current) return;
    registeredRef.current = true;
    // 顺序无强约束，让系统按自己的弹框队列处理。失败只 warn，不打扰用户。
    void requestInputMonitoring().catch((e) =>
      console.warn("[onboarding] auto-register IM failed:", e),
    );
    void requestAccessibility().catch((e) =>
      console.warn("[onboarding] auto-register Accessibility failed:", e),
    );
  }, [platform]);

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
        // 1. denied 路径：先精细 reset 该项的 TCC 条目，让后续 request 能真生效。
        //    notDetermined / restricted / unknown 不 reset——前者是首次接触，
        //    后者是 MDM/系统层限制，reset 帮不上忙也无副作用价值。
        if (currentStatus === "denied") {
          await resetTccPermissionOne(card.permission);
        }
        // 2. request：把 App 写入系统设置的隐私列表 + 触发可能的系统弹窗。
        if (card.permission === "microphone") {
          await requestMicrophone();
        } else if (card.permission === "input-monitoring") {
          await requestInputMonitoring();
        } else if (card.permission === "accessibility") {
          await requestAccessibility();
        }
        // 3. 打开系统设置面板，让用户在已经显示的 App 行上勾选开关。
        await openSystemSettings(card.permission);
        // 触发 / 打开后稍等一拍再检测，让系统授权状态有时间落到 API 层。
        // 用户在系统设置勾选完切回应用时还会再触发一次 recheckAll。
        window.setTimeout(() => {
          void recheck(card);
        }, 600);
      } catch (e) {
        console.warn("[onboarding] permission action failed:", card.id, e);
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
            <span className="text-te-light-gray">// welcome to</span>
            <span className="size-1.5 bg-te-accent" aria-hidden />
            <span className="font-bold tracking-[0.25em]">
              <span className="text-te-fg">OPEN</span>
              <span className="text-te-accent">SPEECH</span>
            </span>
          </div>
          <h1 className="font-mono text-[clamp(1.75rem,4.5vw,3rem)] font-bold leading-[0.95] tracking-tighter text-te-fg">
            说出来。<span className="text-te-accent">就成文。</span>
          </h1>
          <p className="max-w-xl font-sans text-xs leading-relaxed text-te-light-gray">
            按一下快捷键开始说话，再按一下结束——文字立即出现在你正在使用的任何 App 里。
          </p>
        </div>

        {/* 权限分区头部：标号 + 标题 + 副文。与 hero 之间留较大间距，让 hero 单独成块。 */}
        <div className="mt-10 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
            // step 01 / permissions · {platformLabel}
          </span>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-mono text-lg font-bold tracking-tighter text-te-fg md:text-xl">
              {platform === "macos"
                ? "授权 麦克风 与 辅助功能"
                : platform === "windows"
                  ? "授权 麦克风"
                  : "选择麦克风与注入工具"}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {platform === "macos" ? (
                <button
                  type="button"
                  onClick={async () => {
                    await resetTccPermissions();
                    // 重置完后立刻刷新一次 UI，并打开"辅助功能"面板让用户重新勾选。
                    await recheckAll();
                    await openSystemSettings("accessibility");
                  }}
                  className="inline-flex items-center gap-2 border border-te-gray/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
                  title="清空 OpenSpeech 在 TCC 中的旧授权条目（用于已勾选却读不到的场景）"
                >
                  <Eraser className="size-3" /> 重置授权记录
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void recheckAll()}
                className="inline-flex items-center gap-2 border border-te-gray/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
                title="重新检测全部权限"
              >
                <RefreshCw className="size-3" /> 重新检测
              </button>
            </div>
          </div>
          <p className="font-sans text-xs leading-snug text-te-light-gray">
            {headerSummary(platform)}
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
            <span>{allRequiredOk ? "下一步" : "重启 OpenSpeech"}</span>
            {allRequiredOk ? (
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            ) : (
              <RotateCw className="size-4" />
            )}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
            {allRequiredOk
              ? "接下来 2 步：登录 → 试用"
              : "授权后请重启 · 重启后将自动进入下一步"}
          </span>
        </div>
      </motion.div>
    </div>
  );
}
