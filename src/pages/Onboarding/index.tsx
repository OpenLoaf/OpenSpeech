import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cn } from "@/lib/utils";
import { StepWelcome } from "./StepWelcome";
import { StepPermissions } from "./StepPermissions";
import { StepLogin } from "./StepLogin";
import { StepTryIt } from "./StepTryIt";
import { STEP_TITLES, type OnboardingStep } from "./types";

// Onboarding 主路由：4 步状态机 + 顶部进度条 + AnimatePresence 横滑切换。
// 当前实现为纯 UI mock；完成后 navigate("/") 回主界面（不写 onboarding.completed —
// 测试期需要每次启动都看到这个页面，见 main.tsx 的 force-redirect 注释）。

// 引导期窗口尺寸：比主界面紧凑，让 4 步卡片视觉聚焦。完成 / 离开此页时恢复主界面尺寸。
// 顺序：缩小时先 setMinSize（必须 ≤ 目标尺寸），再 setSize；放大时也是先 setMinSize 再 setSize。
// 16:10 比例（880×560）：宽且不高，wizard 卡片不会被竖向拉空。
// minH 调到 520 让小屏笔电也能塞下；MAIN_SIZE 退出时恢复主界面尺寸。
const ONBOARDING_SIZE = { w: 880, h: 560, minW: 820, minH: 520 };
const MAIN_SIZE = { w: 1100, h: 780, minW: 1000, minH: 680 };

async function applyWindowSize(s: { w: number; h: number; minW: number; minH: number }) {
  try {
    const win = getCurrentWebviewWindow();
    await win.setMinSize(new LogicalSize(s.minW, s.minH));
    await win.setSize(new LogicalSize(s.w, s.h));
  } catch (e) {
    console.warn("[onboarding] window resize failed:", e);
  }
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStep>(1);
  const [direction, setDirection] = useState<1 | -1>(1);

  // mount 时缩到引导尺寸，unmount 时恢复主界面尺寸（finish/navigate 都会触发 unmount）
  useEffect(() => {
    void applyWindowSize(ONBOARDING_SIZE);
    return () => {
      void applyWindowSize(MAIN_SIZE);
    };
  }, []);

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
    // TODO: 接业务时调 settingsStore.setGeneral("onboardingCompleted", true)
    navigate("/", { replace: true });
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-te-bg text-te-fg">
      {/* drag region：让窗口在 onboarding 页面也能从顶部拖动 */}
      <div data-tauri-drag-region aria-hidden className="h-8 shrink-0" />

      {/* progress bar */}
      <header className="flex shrink-0 items-center justify-between border-b border-te-gray/60 px-8 py-4">
        <div className="flex items-center gap-3">
          <span className="size-2 bg-te-accent" aria-hidden />
          <span className="font-mono text-sm font-bold tracking-[0.2em]">
            <span className="text-te-fg">OPEN</span>
            <span className="text-te-accent">SPEECH</span>
          </span>
          <span className="ml-2 hidden font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:inline">
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

      <main className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" custom={direction} initial={false}>
          <motion.div
            key={step}
            custom={direction}
            initial={{ opacity: 0, x: direction === 1 ? 40 : -40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction === 1 ? -40 : 40 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="absolute inset-0 overflow-y-auto"
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
