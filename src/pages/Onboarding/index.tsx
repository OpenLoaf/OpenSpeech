import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PulsarGrid } from "@/components/PulsarGrid";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings";
import { StepWelcome } from "./StepWelcome";
import { StepPermissions } from "./StepPermissions";
import { StepLogin } from "./StepLogin";
import { StepTryIt } from "./StepTryIt";
import { STEP_TITLES, type OnboardingStep } from "./types";

// Onboarding 主路由：4 步状态机 + 顶部进度条 + AnimatePresence 横滑切换。
// 当前实现为纯 UI mock；完成后 navigate("/") 回主界面（不写 onboarding.completed —
// 测试期需要每次启动都看到这个页面，见 main.tsx 的 force-redirect 注释）。

// 引导页直接用主窗口尺寸（tauri.conf.json 默认 1100×780，可调整），不再 lock。

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStep>(1);
  const [direction, setDirection] = useState<1 | -1>(1);

  // Cmd+Q / 红叉 / 菜单关闭：Rust 拦截后 emit close-requested，Layout 是默认监听者，
  // 但 onboarding 页不进 Layout，没人监听就会"按下没反应"。这里直接退出（onboarding
  // 期还没决策 close 偏好，HIDE 到托盘也不合理，统一 quit）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const unsub = await listen("openspeech://close-requested", async () => {
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
    if (step >= 4) return;
    setDirection(1);
    setStep((s) => (s + 1) as OnboardingStep);
  };

  const goBack = () => {
    if (step <= 1) return;
    setDirection(-1);
    setStep((s) => (s - 1) as OnboardingStep);
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
          <span className="size-2 bg-te-accent" aria-hidden />
          <span className="font-mono text-sm font-bold tracking-[0.2em]">
            <span className="text-te-fg">OPEN</span>
            <span className="text-te-accent">SPEECH</span>
          </span>
          <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
            // first run setup
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {String(step).padStart(2, "0")} / 04 · {STEP_TITLES[step]}
          </span>
          <div className="flex w-44 gap-1">
            {[1, 2, 3, 4].map((i) => (
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
        <AnimatePresence mode="wait" custom={direction} initial={false}>
          <motion.div
            key={step}
            custom={direction}
            initial={{ opacity: 0, x: direction === 1 ? 40 : -40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction === 1 ? -40 : 40 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="absolute inset-0 overflow-hidden"
          >
            {step === 1 ? (
              <StepWelcome onNext={goNext} />
            ) : step === 2 ? (
              <StepPermissions onNext={goNext} onBack={goBack} />
            ) : step === 3 ? (
              <StepLogin onNext={goNext} onBack={goBack} />
            ) : (
              <StepTryIt onBack={goBack} onComplete={finish} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
