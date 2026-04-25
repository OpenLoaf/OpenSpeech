import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// Step 3：强制登录 OpenLoaf。登录成功送 200 积分（≈ 30 分钟语音）。
// Mock：点任一登录方式 → loading 1.2s → 视为成功 → 自动跳下一步。

type LoginMethod = "google" | "wechat" | "email";

const METHODS: Array<{ id: LoginMethod; label: string; sub: string }> = [
  { id: "google", label: "使用 Google 账号登录", sub: "推荐 · 一键完成" },
  { id: "wechat", label: "微信扫码登录", sub: "国内用户首选" },
  { id: "email", label: "邮箱注册 / 登录", sub: "永久免费" },
];

export function StepLogin({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const [pending, setPending] = useState<LoginMethod | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const simulateLogin = (m: LoginMethod) => {
    setPending(m);
    window.setTimeout(() => {
      setPending(null);
      onNext();
    }, 1200);
  };

  return (
    <div className="flex h-full w-full flex-col px-8 py-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex w-full max-w-md flex-col gap-6"
      >
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
            // step 03 / account
          </span>
          <h2 className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
            登录 OpenLoaf 账号
          </h2>
          <p className="font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
            OpenSpeech 默认走 OpenLoaf SaaS 实时识别引擎，体验最稳。
          </p>
        </div>

        <div className="flex items-start gap-3 border border-te-accent/40 bg-te-accent/5 p-4">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-te-accent" />
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-te-accent">
              新用户立即到账 200 积分
            </span>
            <span className="font-sans text-xs leading-relaxed text-te-light-gray">
              约可识别 <span className="font-mono text-te-fg">30 分钟</span> 语音 ——
              足够你跑通"按下快捷键 → 看到文字"的整套体验。
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {METHODS.map((m) => {
            const loading = pending === m.id;
            const disabled = pending !== null && !loading;
            return (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                onClick={() => simulateLogin(m.id)}
                className={cn(
                  "group flex items-center justify-between gap-3 border px-4 py-3 transition-colors",
                  loading
                    ? "border-te-accent bg-te-accent/10"
                    : disabled
                      ? "cursor-not-allowed border-te-gray/40 opacity-50"
                      : "border-te-gray/60 bg-te-surface hover:border-te-accent",
                )}
              >
                <div className="flex flex-col items-start gap-0.5">
                  <span className="font-mono text-sm font-bold tracking-tight text-te-fg">
                    {m.label}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                    {m.sub}
                  </span>
                </div>
                {loading ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-te-accent" />
                ) : (
                  <ArrowRight className="size-4 shrink-0 text-te-light-gray transition-transform group-hover:translate-x-1 group-hover:text-te-accent" />
                )}
              </button>
            );
          })}
        </div>

        <div className="border-t border-te-gray/40 pt-4">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray underline-offset-4 transition-colors hover:text-te-fg hover:underline"
          >
            {advanced ? "↑ 收起高级选项" : "↓ 我有自己的 STT 端点（高级）"}
          </button>

          {advanced ? (
            <div className="mt-3 flex flex-col gap-2 border border-te-gray/60 bg-te-surface p-4">
              <p className="font-sans text-xs leading-relaxed text-te-light-gray">
                配置自定义 REST STT 端点（OpenAI / Groq / Deepgram / 自部署）。
                此选项仅推荐给开发者；普通用户请用上方账号登录。
              </p>
              <button
                type="button"
                onClick={onNext}
                className="self-start border border-te-gray px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
              >
                跳过登录，使用自定义端点
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
          >
            <ArrowLeft className="size-3" /> 上一步
          </button>
        </div>
      </motion.div>
    </div>
  );
}
