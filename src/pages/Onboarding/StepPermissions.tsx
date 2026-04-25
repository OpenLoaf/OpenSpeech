import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  ExternalLink,
  Loader2,
  Mic,
  Keyboard,
  KeyRound,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { detectPlatform, type Platform } from "@/lib/platform";
import type { PermissionStatus } from "./types";

// Step 2：按平台动态显示权限卡。所有"模拟授权"按钮都是 mock —— 只切本地 status，
// 不调任何 Rust API。这样测试时不需要真正反复授权 / 撤销系统权限。

type PermissionId = "microphone" | "accessibility" | "input-monitoring" | "inject-tools";

type PermissionCard = {
  id: PermissionId;
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
        icon: Mic,
        title: "听到你说话",
        rationale: "OpenSpeech 需要读取麦克风，把你的语音送到识别引擎。",
        systemTermHint: "系统设置 → 隐私与安全性 → 麦克风",
        required: true,
      },
      {
        id: "accessibility",
        icon: Keyboard,
        title: "把识别出的文字打到任何 App 里",
        rationale: "只有授权辅助功能后，OpenSpeech 才能模拟键盘把文字输入到当前焦点的输入框。",
        systemTermHint: "系统设置 → 隐私与安全性 → 辅助功能",
        required: true,
      },
      {
        id: "input-monitoring",
        icon: KeyRound,
        title: "听到你按下快捷键（即使在用别的 App）",
        rationale: "授权后即使你正在用其它应用，按下听写快捷键也能立刻触发录音。",
        systemTermHint: "系统设置 → 隐私与安全性 → 输入监控",
        required: false,
      },
    ];
  }
  if (platform === "windows") {
    return [
      {
        id: "microphone",
        icon: Mic,
        title: "听到你说话",
        rationale: "OpenSpeech 需要读取麦克风，把你的语音送到识别引擎。",
        systemTermHint: "Windows 设置 → 隐私 → 麦克风",
        required: true,
      },
      {
        id: "inject-tools",
        icon: Wrench,
        title: "目标程序权限提示",
        rationale: "若你常用的程序以管理员身份运行（如 cmd），OpenSpeech 也需要相同权限才能注入文字。",
        required: false,
      },
    ];
  }
  return [
    {
      id: "microphone",
      icon: Mic,
      title: "选择麦克风设备",
      rationale: "Linux 不需要授权弹窗；从 PipeWire / PulseAudio 选一个输入设备即可。",
      required: true,
    },
    {
      id: "inject-tools",
      icon: Wrench,
      title: "检测注入工具",
      rationale: "Wayland 下需要 ydotool / wtype，X11 下需要 xdotool。OpenSpeech 会自动检测。",
      required: true,
    },
  ];
}

function PermissionRow({
  card,
  status,
  onSimulateGrant,
  onSimulateDeny,
  onOpenSystem,
}: {
  card: PermissionCard;
  status: PermissionStatus;
  onSimulateGrant: () => void;
  onSimulateDeny: () => void;
  onOpenSystem: () => void;
}) {
  const Icon = card.icon;
  const granted = status === "granted";
  const denied = status === "denied";
  const checking = status === "checking";

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border bg-te-surface p-4 transition-colors md:flex-row md:items-start md:gap-4",
        granted
          ? "border-te-accent/60"
          : denied
            ? "border-te-accent/40 bg-te-accent/5"
            : "border-te-gray/60",
      )}
    >
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center border",
          granted ? "border-te-accent text-te-accent" : "border-te-gray text-te-light-gray",
        )}
      >
        {granted ? <Check className="size-5" /> : <Icon className="size-5" />}
      </div>

      <div className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-te-fg">
            {card.title}
          </span>
          {card.required ? (
            <span className="border border-te-accent/60 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.2em] text-te-accent">
              必需
            </span>
          ) : (
            <span className="border border-te-gray/60 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.2em] text-te-light-gray">
              推荐
            </span>
          )}
        </div>
        <p className="font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
          {card.rationale}
        </p>
        {card.systemTermHint ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray/70">
            {card.systemTermHint}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {checking ? (
          <span className="inline-flex items-center gap-2 border border-te-gray/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            <Loader2 className="size-3 animate-spin" /> 检测中
          </span>
        ) : granted ? (
          <span className="inline-flex items-center gap-2 border border-te-accent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-accent">
            <Check className="size-3" /> 已授权
          </span>
        ) : denied ? (
          <button
            type="button"
            onClick={onOpenSystem}
            className="inline-flex items-center gap-2 border border-te-accent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-accent transition-colors hover:bg-te-accent hover:text-te-accent-fg"
          >
            去系统设置 <ExternalLink className="size-3" />
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onSimulateGrant}
              className="inline-flex items-center gap-2 border border-te-accent bg-te-accent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
            >
              授权
            </button>
            <button
              type="button"
              onClick={onSimulateDeny}
              className="inline-flex items-center gap-1 border border-te-gray px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-fg hover:text-te-fg"
              title="测试用：模拟用户拒绝"
            >
              拒绝
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function StepPermissions({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const platform = detectPlatform();
  const cards = useMemo(() => cardsForPlatform(platform), [platform]);
  const [statuses, setStatuses] = useState<Record<PermissionId, PermissionStatus>>(
    () =>
      cards.reduce(
        (acc, c) => ({ ...acc, [c.id]: "idle" }),
        {} as Record<PermissionId, PermissionStatus>,
      ),
  );

  const setStatus = (id: PermissionId, s: PermissionStatus) =>
    setStatuses((prev) => ({ ...prev, [id]: s }));

  const allRequiredOk = cards.every(
    (c) => !c.required || statuses[c.id] === "granted",
  );

  const platformLabel =
    platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux";

  return (
    <div className="flex h-full w-full flex-col px-8 py-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex w-full max-w-2xl flex-col gap-6"
      >
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
            // step 02 / permissions · {platformLabel}
          </span>
          <h2 className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
            授权所需的系统权限
          </h2>
          <p className="font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
            OpenSpeech 是桌面应用，需要操作系统授予以下权限才能工作。下面用人话解释每一项 ——
            点"授权"会请求系统弹窗，点"拒绝"用于测试被拒后的引导路径。
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {cards.map((card) => (
            <PermissionRow
              key={card.id}
              card={card}
              status={statuses[card.id]}
              onSimulateGrant={() => {
                setStatus(card.id, "checking");
                window.setTimeout(() => setStatus(card.id, "granted"), 600);
              }}
              onSimulateDeny={() => setStatus(card.id, "denied")}
              onOpenSystem={() => {
                setStatus(card.id, "checking");
                window.setTimeout(() => setStatus(card.id, "granted"), 1200);
              }}
            />
          ))}
        </div>

        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
          >
            <ArrowLeft className="size-3" /> 上一步
          </button>
          <button
            type="button"
            disabled={!allRequiredOk}
            onClick={onNext}
            className={cn(
              "group inline-flex items-center gap-3 border px-6 py-3 font-mono text-sm font-bold uppercase tracking-[0.2em] transition-colors",
              allRequiredOk
                ? "border-te-accent bg-te-accent text-te-accent-fg hover:bg-te-accent/90"
                : "cursor-not-allowed border-te-gray/40 text-te-light-gray/40",
            )}
          >
            <span>{allRequiredOk ? "下一步" : "请先授权必需项"}</span>
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </button>
        </div>
      </motion.div>
    </div>
  );
}
