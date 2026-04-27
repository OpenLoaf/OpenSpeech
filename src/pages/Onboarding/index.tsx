import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { PulsarGrid } from "@/components/PulsarGrid";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useSettingsStore } from "@/stores/settings";
import { StepPermissions } from "./StepPermissions";
import { StepLogin } from "./StepLogin";
import { StepTryIt } from "./StepTryIt";
import { STEP_TITLES, type OnboardingStep } from "./types";

// Onboarding 主路由：3 步状态机（权限 → 登录 → 试用）+ 顶部进度条 +
// AnimatePresence 横滑切换。完成后 navigate("/") 回主界面，并写
// `settings.general.onboardingCompleted = true` 持久化，下次启动直接进主界面。

// 引导页直接用主窗口尺寸（tauri.conf.json 默认 1100×780，可调整），不再 lock。

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStep>(1);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

  // 引导期只响应 Cmd+Q（quit-requested）这条明确退出路径——Cmd+Q 在 macOS 任何 app
  // 都意味着退出，必须保留。Cmd+W / 红叉走 close-requested，引导期直接忽略：用户在
  // 半完成引导状态下误触 Cmd+W 不应让整个 app 退出（Rust 已 prevent_close，前端不响
  // 应即等同"什么都不发生"）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const unsub = await listen("openspeech://quit-requested", async () => {
        await invoke("exit_app");
      });
      if (cancelled) unsub();
      else unlisten = unsub;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const goNext = () => {
    if (step >= 3) return;
    // Step 1 → 已登录直接跳到 Step 3：用户都已经登录了就别再让登录页一闪而过
    // （StepLogin 挂载时 600ms 自跳的过场没必要看）。
    if (step === 1 && useAuthStore.getState().isAuthenticated) {
      setStep(3);
      return;
    }
    setStep((s) => (s + 1) as OnboardingStep);
  };

  const finish = () => {
    // 引导走完 → 标记 onboardingCompleted=true 持久化到 settings.json，下次启动直接进主界面
    void useSettingsStore.getState().setGeneral("onboardingCompleted", true);
    navigate("/", { replace: true });
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-te-bg text-te-fg">
      {/* 与首页同款的 PulsarGrid 动态背景 + 径向遮罩。pointer-events-none 让 header drag 区
          与按钮交互全部正常透传；canvas 自身用 window 级 mousemove 不依赖 DOM 捕获事件 */}
      <div className="pointer-events-none absolute inset-0">
        <PulsarGrid />
      </div>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 70% at 50% 45%, transparent 30%, var(--te-bg) 95%)",
        }}
      />

      {/* header 与红绿灯同行：整个 header 都是 drag 区，左侧 pl-20 给 macOS 红绿灯让位
          （Windows / Linux 该 padding 也无害，只是稍空一点）。drag-region 在父级生效，
          子级文字 / span 都自动可拖；如果未来加按钮，给那个按钮单独 data-tauri-drag-region="false" */}
      <header
        data-tauri-drag-region
        className="relative z-10 flex h-12 shrink-0 items-center justify-between border-b border-te-gray/60 pl-20 pr-6"
      >
        <div className="flex items-center gap-3">
          <img
            src="/logo-write.png"
            alt=""
            aria-hidden
            className="size-5 shrink-0 select-none"
            draggable={false}
          />
          <span className="font-mono text-sm font-bold tracking-[0.2em]">
            <span className="text-te-fg">OPEN</span>
            <span className="text-te-accent">SPEECH</span>
          </span>
          <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
            // first run setup
          </span>
          {appVersion && (
            <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-te-light-gray/70">
              v{appVersion}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {String(step).padStart(2, "0")} / 03 · {STEP_TITLES[step]}
          </span>
          <div className="flex w-36 gap-1">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className={cn(
                  "h-[3px] flex-1 transition-colors",
                  i < step
                    ? "bg-te-accent"
                    : i === step
                      ? "bg-te-accent/70"
                      : "bg-te-gray/40",
                )}
              />
            ))}
          </div>
        </div>
      </header>

      <main className="relative z-10 min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="absolute inset-0 overflow-hidden"
          >
            {step === 1 ? (
              <StepPermissions onNext={goNext} />
            ) : step === 2 ? (
              <StepLogin onNext={goNext} />
            ) : (
              <StepTryIt onComplete={finish} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
