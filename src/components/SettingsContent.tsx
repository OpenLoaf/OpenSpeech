import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  info as logInfo,
  error as logError,
} from "@tauri-apps/plugin-log";
import i18next from "i18next";
import {
  useSettingsStore,
  DEFAULT_AI_SYSTEM_PROMPTS,
  DEFAULT_AI_TRANSLATION_SYSTEM_PROMPTS,
  DEFAULT_AI_POLISH_SYSTEM_PROMPTS,
  DEFAULT_AI_MEETING_SUMMARY_PROMPTS,
  DEFAULT_POLISH_SCENARIOS,
  hasUnverifiedActiveDictation,
  hasUnverifiedActiveAiRefine,
  type PolishScenario,
} from "@/stores/settings";
import { resolveLang } from "@/i18n";
import { useUIStore } from "@/stores/ui";
import {
  listInputDevices,
  startAudioLevel,
  stopAudioLevel,
  type InputDeviceInfo,
} from "@/lib/audio";
import {
  ChevronDown,
  ExternalLink,
  Sliders,
  Info,
  Rocket,
  MessageSquare,
  FolderOpen,
  Mic,
  Bot,
  Trash2,
  Plus,
  FlaskConical,
  Loader2,
  Keyboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { syncAutostart } from "@/lib/autostart";
import {
  loadAiProviderKey,
  saveAiProviderKey,
  loadDictationProviderCredentials,
  saveDictationProviderCredentials,
  type DictationCredentials,
} from "@/lib/secrets";
import type { DictationCustomProvider } from "@/stores/settings";
import { testDictationProvider } from "@/lib/dictation-provider";
import { refineTextViaChatStream } from "@/lib/ai-refine";
import {
  checkForUpdateForChannel,
  installUpdateWithProgress,
} from "@/lib/updaterInstall";
import { HotkeyBinder } from "@/components/HotkeyBinder";
import { useHotkeysStore } from "@/stores/hotkeys";
import { detectPlatform } from "@/lib/platform";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* ──────────────────────────────────────────────────────────────── */
/*  Types                                                             */
/* ──────────────────────────────────────────────────────────────── */

import type { SettingsTabId } from "@/stores/ui";
type TabId = SettingsTabId;

type TabDef = {
  id: TabId;
  label: string;
  icon: typeof Sliders;
};

type SubNavAction = {
  id: string;
  label: string;
  icon: typeof Sliders;
  onClick: () => void;
};

function useTabs(): TabDef[] {
  const { t } = useTranslation("settings");
  return [
    { id: "GENERAL", label: t("tabs.general"), icon: Sliders },
    { id: "HOTKEYS", label: t("tabs.hotkeys"), icon: Keyboard },
    { id: "DICTATION", label: t("tabs.dictation"), icon: Mic },
    { id: "AI", label: t("tabs.ai"), icon: Bot },
    { id: "ABOUT", label: t("tabs.about"), icon: Info },
  ];
}

/* ──────────────────────────────────────────────────────────────── */
/*  Primitive controls (TE industrial)                                */
/* ──────────────────────────────────────────────────────────────── */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-10 mb-4 flex items-center gap-3 first:mt-0">
      <span className="h-px w-4 bg-te-accent" />
      <h3 className="font-mono text-xs uppercase tracking-[0.25em] text-te-light-gray">
        {children}
      </h3>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-te-gray/30 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="font-sans text-sm text-te-fg">{label}</div>
        {hint ? (
          <div className="mt-1 font-sans text-xs text-te-light-gray/80">
            {hint}
          </div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}


function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative flex h-[22px] w-10 items-center rounded-sm border transition-colors",
        checked
          ? "border-te-accent bg-te-accent"
          : "border-te-gray/60 bg-te-gray",
        disabled && "cursor-not-allowed opacity-40",
      )}
      aria-pressed={checked}
      aria-disabled={disabled}
    >
      <motion.span
        layout
        transition={{ type: "tween", duration: 0.18 }}
        className={cn(
          "size-4",
          checked ? "ml-auto mr-[2px] bg-te-accent-fg" : "ml-[2px] bg-te-bg",
        )}
      />
    </button>
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: readonly T[] | { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const opts = (options as unknown[]).map((o) =>
    typeof o === "string"
      ? { value: o as T, label: o as string }
      : (o as { value: T; label: string }),
  );
  return (
    <div
      className={cn(
        "relative inline-flex items-center border border-te-gray/40 bg-te-surface transition-colors focus-within:border-te-accent hover:border-te-gray",
        className,
      )}
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-w-[10rem] cursor-pointer appearance-none bg-transparent py-2 pr-8 pl-3 font-mono text-sm text-te-fg focus:outline-none"
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-te-light-gray" />
    </div>
  );
}

function RadioBlock<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "group relative flex flex-col items-start gap-1 border px-4 py-3 text-left transition-colors",
              active
                ? "border-te-accent bg-te-accent/8 text-te-accent"
                : "border-te-gray/40 text-te-fg hover:border-te-gray",
            )}
          >
            <div className="flex w-full items-center justify-between">
              <span className="font-mono text-xs uppercase tracking-[0.15em]">
                {o.label}
              </span>
              <span
                className={cn(
                  "size-2",
                  active ? "bg-te-accent" : "bg-te-gray",
                )}
              />
            </div>
            {o.hint ? (
              <span
                className={cn(
                  "font-sans text-xs",
                  active ? "text-te-accent/80" : "text-te-light-gray",
                )}
              >
                {o.hint}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function LevelMeter({ peak }: { peak: number }) {
  // peak ∈ [0, 1]；人耳感知音量是对数的，线性映射导致普通说话（peak≈0.1-0.2）
  // 几乎打不到 2 格。sqrt 把曲线压平：0.1 → 0.316、0.2 → 0.447、0.5 → 0.707。
  // 配合 ceil 与 0.03 noise floor，安静环境静默、开口即亮 2 格左右、大声到 5 格。
  const clamped = Math.max(0, Math.min(1, peak));
  const normalized = clamped < 0.03 ? 0 : Math.sqrt(clamped);
  const filled =
    normalized === 0
      ? 0
      : Math.min(5, Math.max(1, Math.ceil(normalized * 5)));
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-4 w-6 border transition-colors",
            i < filled
              ? "border-te-accent bg-te-accent"
              : "border-te-gray/40 bg-te-surface",
          )}
        />
      ))}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Tab content                                                       */
/* ──────────────────────────────────────────────────────────────── */

function GeneralTab() {
  const { t } = useTranslation("settings");
  const general = useSettingsStore((s) => s.general);
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const loaded = useSettingsStore((s) => s.loaded);

  return (
    <div>
      {/* Language */}
      <SectionTitle>{t("section.language")}</SectionTitle>
      <Row label={t("general.interface_lang")}>
        <Select
          value={general.interfaceLang}
          onChange={(v) => void setGeneral("interfaceLang", v)}
          options={[
            { value: "system", label: t("common:lang.system") },
            { value: "zh-CN", label: t("common:lang.zh-CN") },
            { value: "zh-TW", label: t("common:lang.zh-TW") },
            { value: "en", label: t("common:lang.en") },
          ]}
        />
      </Row>
      <Row
        label={t("general.translate_target_lang")}
        hint={t("general.translate_target_lang_hint")}
      >
        <Select
          value={general.translateTargetLang}
          onChange={(v) =>
            void setGeneral(
              "translateTargetLang",
              v as typeof general.translateTargetLang,
            )
          }
          options={[
            { value: "en", label: t("translate_target_lang.en") },
            { value: "zh", label: t("translate_target_lang.zh") },
            { value: "zh-TW", label: t("translate_target_lang.zh-TW") },
            { value: "ja", label: t("translate_target_lang.ja") },
            { value: "ko", label: t("translate_target_lang.ko") },
            { value: "fr", label: t("translate_target_lang.fr") },
            { value: "de", label: t("translate_target_lang.de") },
            { value: "es", label: t("translate_target_lang.es") },
          ]}
        />
      </Row>
      <Row
        label={t("general.translate_output_mode")}
        hint={t("general.translate_output_mode_hint")}
      >
        <Select
          value={general.translateOutputMode}
          onChange={(v) =>
            void setGeneral(
              "translateOutputMode",
              v as typeof general.translateOutputMode,
            )
          }
          options={[
            {
              value: "target_only",
              label: t("translate_output_mode.target_only"),
            },
            {
              value: "bilingual",
              label: t("translate_output_mode.bilingual"),
            },
          ]}
        />
      </Row>
      {/* Behavior */}
      <SectionTitle>{t("section.behavior")}</SectionTitle>
      <Row label={t("general.launch_startup")}>
        <Switch
          checked={general.launchStartup}
          onChange={(v) => {
            void setGeneral("launchStartup", v);
            void syncAutostart(v);
          }}
        />
      </Row>
      {detectPlatform() === "macos" ? (
        <Row
          label={t("general.show_dock")}
          hint={t("general.show_dock_hint")}
        >
          <Switch
            checked={general.showDockIcon}
            onChange={(v) => {
              void setGeneral("showDockIcon", v);
              void invoke("sync_dock_icon").catch((e) =>
                console.warn("[dock] sync failed:", e),
              );
            }}
          />
        </Row>
      ) : null}
      <Row
        label={t("general.close_to_tray")}
        hint={t("general.close_to_tray_hint")}
      >
        <Switch
          checked={general.closeBehavior === "HIDE"}
          onChange={(v) =>
            void setGeneral("closeBehavior", v ? "HIDE" : "ASK")
          }
        />
      </Row>
      <Row
        label={t("general.update_policy")}
        hint={t("general.update_policy_hint")}
      >
        <Select
          value={general.updatePolicy}
          onChange={(v) => void setGeneral("updatePolicy", v)}
          options={[
            { value: "PROMPT", label: t("general.update_policy_options.prompt") },
            { value: "AUTO", label: t("general.update_policy_options.auto") },
            { value: "DISABLED", label: t("general.update_policy_options.disabled") },
          ]}
        />
      </Row>
      <Row
        label={t("general.update_check_interval")}
        hint={t("general.update_check_interval_hint")}
      >
        <Select
          value={String(general.updateCheckIntervalHours)}
          onChange={(v) =>
            void setGeneral("updateCheckIntervalHours", Number(v))
          }
          options={[
            { value: "1", label: t("general.update_check_interval_options.1h") },
            { value: "6", label: t("general.update_check_interval_options.6h") },
            { value: "24", label: t("general.update_check_interval_options.24h") },
          ]}
        />
      </Row>

      {!loaded ? (
        <div className="mt-6 font-mono text-xs text-te-light-gray/70">
          {t("general.loading")}
        </div>
      ) : null}
    </div>
  );
}

function HotkeysTab() {
  const { t } = useTranslation("settings");
  const resetAll = useHotkeysStore((s) => s.resetAll);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  const handleConfirmReset = async () => {
    await resetAll();
    setResetConfirmOpen(false);
    toast.success(t("hotkeys.reset_all_done"));
  };

  return (
    <div>
      <div className="mt-10 mb-4 flex items-center justify-between gap-3 first:mt-0">
        <div className="flex items-center gap-3">
          <span className="h-px w-4 bg-te-accent" />
          <h3 className="font-mono text-xs uppercase tracking-[0.25em] text-te-light-gray">
            {t("section.shortcuts")}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setResetConfirmOpen(true)}
          className="border border-te-gray/40 bg-te-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
        >
          {t("hotkeys.reset_all")}
        </button>
      </div>
      <HotkeyBinder size="comfortable" />

      <ResetHotkeysConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        onConfirm={() => void handleConfirmReset()}
      />
    </div>
  );
}

function ResetHotkeysConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex w-[92vw] max-w-sm flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-sm"
      >
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("hotkeys.reset_all")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("hotkeys.reset_all_confirm")}
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 py-5 font-sans text-sm text-te-light-gray">
          {t("hotkeys.reset_all_confirm")}
        </div>
        <div className="flex items-stretch border-t border-te-dialog-border">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex-1 border-r border-te-dialog-border px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:bg-te-surface-hover hover:text-te-fg"
          >
            {t("common:actions.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 bg-te-accent px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            {t("common:actions.confirm")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DictationTab() {
  const { t } = useTranslation("settings");
  const general = useSettingsStore((s) => s.general);
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const loaded = useSettingsStore((s) => s.loaded);
  const aiRefine = useSettingsStore((s) => s.aiRefine);
  const setAiRefineEnabled = useSettingsStore((s) => s.setAiRefineEnabled);
  const dictation = useSettingsStore((s) => s.dictation);
  const setDictationMode = useSettingsStore((s) => s.setDictationMode);
  const setDictationLang = useSettingsStore((s) => s.setDictationLang);
  const addDictationProvider = useSettingsStore((s) => s.addDictationProvider);
  const updateDictationProvider = useSettingsStore(
    (s) => s.updateDictationProvider,
  );
  const removeDictationProvider = useSettingsStore(
    (s) => s.removeDictationProvider,
  );
  const setActiveDictationProvider = useSettingsStore(
    (s) => s.setActiveDictationProvider,
  );
  const setDictationStreamingInject = useSettingsStore(
    (s) => s.setDictationStreamingInject,
  );
  const setDictationClipboardCopy = useSettingsStore(
    (s) => s.setDictationClipboardCopy,
  );

  // 真实输入设备列表（cpal 枚举）
  const [devices, setDevices] = useState<InputDeviceInfo[]>([]);
  useEffect(() => {
    void (async () => {
      const list = await listInputDevices();
      setDevices(list);
    })();
  }, []);

  // 实时麦克风 peak（0..1）。Tab mount 时 start 采集，unmount 时 stop；
  // 设备变化时重新 start（Rust 侧会 restart stream 并保持 ref_count）。
  const [peak, setPeak] = useState<number>(0);
  const peakDecayTimer = useRef<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // startAudioLevel 异步竞态兜底：cleanup 跑 stopAudioLevel 时 Rust ref_count
    // 还没 +1（startAudioLevel 在 macOS 上要 ~1s 才 resolve），保护到 0 实际什么
    // 都没干；等后来的 startAudioLevel resolve，ref_count = 1 永久残留 → mic 状态
    // 栏指示常驻。这里追踪 startPromise，cleanup 时 await 它的结果，若启动成功且
    // 已 cancelled，补一次 stopAudioLevel 把 ref_count 平回去。
    const startPromise = startAudioLevel(general.inputDevice || null);

    (async () => {
      const unsub = await listen<number>(
        "openspeech://audio-level",
        (evt) => {
          const v = Math.max(0, Math.min(1, Number(evt.payload) || 0));
          setPeak(v);
        },
      );
      if (cancelled) {
        unsub();
      } else {
        unlisten = unsub;
      }
    })();

    // 若 20Hz tick 意外丢失，peak 会卡住；每 150ms 衰减避免"卡住点亮"。
    peakDecayTimer.current = window.setInterval(() => {
      setPeak((p) => (p > 0.02 ? p * 0.6 : 0));
    }, 150) as unknown as number;

    return () => {
      cancelled = true;
      unlisten?.();
      // 同步 stopAudioLevel 兜底（startAudioLevel 已 resolve 的常规路径）+ 异步
      // 等 startPromise 兜底（resolve 在 cleanup 后到达的竞态路径）。两次 stop 不
      // 会重复扣减——Rust ref_count 在 0 时 stop 是 no-op。
      void stopAudioLevel();
      void startPromise.then((ok) => {
        if (ok) void stopAudioLevel();
      });
      if (peakDecayTimer.current !== null) {
        clearInterval(peakDecayTimer.current);
        peakDecayTimer.current = null;
      }
    };
    // 关键：依赖 general.inputDevice，切设备时重新 start
  }, [general.inputDevice]);

  // 持久化的是用户的"原始偏好"（空串 = 跟随系统；非空 = 显式选的名字）。
  // 运行时的 "effective device"（实际在用的）遵循：
  //   wanted=""           → 系统默认
  //   wanted ∈ devices    → wanted
  //   wanted ∉ devices    → 系统默认（持久化不动，等设备回来自动恢复）
  // 这里只影响 Select 的 label 显示；Rust 侧 start() 已有同样 fallback，
  // 前端传原始 wanted 给 Rust 即可，拔插设备也不会把用户的偏好洗掉。
  const systemDefaultName = useMemo(
    () => devices.find((d) => d.isDefault)?.name ?? "",
    [devices],
  );
  const wanted = general.inputDevice;
  const effectiveName =
    wanted !== "" && devices.some((d) => d.name === wanted)
      ? wanted
      : systemDefaultName;

  const deviceOptions = useMemo(() => {
    const base: { value: string; label: string }[] = [
      {
        value: "",
        label: systemDefaultName
          ? t("device.system_default_with_current", { name: systemDefaultName })
          : t("device.system_default"),
      },
    ];
    for (const d of devices) {
      base.push({
        value: d.name,
        label: d.isDefault
          ? t("device.is_default_suffix", { name: d.name })
          : d.name,
      });
    }
    if (wanted && !devices.some((d) => d.name === wanted)) {
      base.push({
        value: wanted,
        label: systemDefaultName
          ? t("device.disconnected_with_fallback", {
              name: wanted,
              fallback: systemDefaultName,
            })
          : t("device.disconnected", { name: wanted }),
      });
    }
    return base;
  }, [devices, wanted, systemDefaultName, t]);

  return (
    <div>
      {/* Dictation provider（听写通道）*/}
      <SectionTitle>{t("dictation_provider.section_mode")}</SectionTitle>
      <div className="py-3">
        <RadioBlock
          value={dictation.mode}
          onChange={(v) => void setDictationMode(v)}
          options={[
            {
              value: "saas",
              label: t("dictation_provider.mode_saas_label"),
              hint: t("dictation_provider.mode_saas_hint"),
            },
            {
              value: "custom",
              label: t("dictation_provider.mode_custom_label"),
              hint: t("dictation_provider.mode_custom_hint"),
            },
          ]}
        />
      </div>

      {dictation.mode === "custom" && (
        <>
          <SectionTitle>
            {t("dictation_provider.section_providers")}
          </SectionTitle>
          {dictation.customProviders.length === 0 ? (
            <div className="border border-dashed border-te-gray/40 px-4 py-6 text-center font-mono text-xs text-te-light-gray">
              {t("dictation_provider.providers_empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {dictation.customProviders.map((p) => (
                <DictationProviderCard
                  key={p.id}
                  provider={p}
                  isActive={p.id === dictation.activeCustomProviderId}
                  onUpdate={(patch) => void updateDictationProvider(p.id, patch)}
                  onRemove={() => void removeDictationProvider(p.id)}
                  onSetActive={() => void setActiveDictationProvider(p.id)}
                />
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                const id =
                  typeof crypto !== "undefined" && "randomUUID" in crypto
                    ? crypto.randomUUID()
                    : `dict_${Date.now()}_${Math.random()
                        .toString(36)
                        .slice(2, 8)}`;
                void addDictationProvider({
                  id,
                  name: t("dictation_provider.tencent_default_name"),
                  vendor: "tencent",
                  tencentAppId: "",
                  tencentRegion: "ap-shanghai",
                });
              }}
              className="inline-flex items-center gap-2 border border-te-gray/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
            >
              <Plus className="size-3.5" />
              {t("dictation_provider.add_tencent")}
            </button>
            <button
              type="button"
              onClick={() => {
                const id =
                  typeof crypto !== "undefined" && "randomUUID" in crypto
                    ? crypto.randomUUID()
                    : `dict_${Date.now()}_${Math.random()
                        .toString(36)
                        .slice(2, 8)}`;
                void addDictationProvider({
                  id,
                  name: t("dictation_provider.aliyun_default_name"),
                  vendor: "aliyun",
                });
              }}
              className="inline-flex items-center gap-2 border border-te-gray/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
            >
              <Plus className="size-3.5" />
              {t("dictation_provider.add_aliyun")}
            </button>
          </div>
        </>
      )}

      {/* Audio */}
      <SectionTitle>{t("section.audio")}</SectionTitle>
      <Row label={t("general.input_device")}>
        <Select
          value={general.inputDevice}
          onChange={(v) => void setGeneral("inputDevice", v)}
          className="min-w-[18rem]"
          options={deviceOptions}
        />
      </Row>
      <Row
        label={t("general.input_level")}
        hint={
          effectiveName
            ? t("general.input_level_hint_listening", { name: effectiveName })
            : t("general.input_level_hint")
        }
      >
        <LevelMeter peak={peak} />
      </Row>
      <Row label={t("general.cue_sound")}>
        <Switch
          checked={general.cueSound}
          onChange={(v) => void setGeneral("cueSound", v)}
        />
      </Row>
      <Row label={t("dictation_lang.label")} hint={t("dictation_lang.hint")}>
        <Select
          value={dictation.lang}
          onChange={(v) => void setDictationLang(v as typeof dictation.lang)}
          options={[
            { value: "follow_interface", label: t("dictation_lang.follow_interface") },
            { value: "auto", label: t("dictation_lang.auto") },
            { value: "zh", label: t("dictation_lang.zh") },
            { value: "en", label: t("dictation_lang.en") },
            { value: "ja", label: t("dictation_lang.ja") },
            { value: "ko", label: t("dictation_lang.ko") },
            { value: "yue", label: t("dictation_lang.yue") },
          ]}
        />
      </Row>

      {/* Dictation mode */}
      <SectionTitle>{t("section.asr_segment")}</SectionTitle>
      <div className="py-3">
        <RadioBlock
          value={general.asrSegmentMode}
          onChange={(v) => void setGeneral("asrSegmentMode", v)}
          options={[
            {
              value: "UTTERANCE",
              label: t("asr_segment.utterance_label"),
              hint: t("asr_segment.utterance_hint"),
            },
            {
              value: "REALTIME",
              label: t("asr_segment.realtime_label"),
              hint: t("asr_segment.realtime_hint"),
            },
          ]}
        />
      </div>
      <Row
        label={t("asr_segment.ai_refine_toggle.label")}
        hint={
          general.asrSegmentMode === "REALTIME"
            ? t("asr_segment.ai_refine_toggle.disabled_in_realtime")
            : t("asr_segment.ai_refine_toggle.hint")
        }
      >
        <Switch
          checked={general.asrSegmentMode !== "REALTIME" && aiRefine.enabled}
          disabled={general.asrSegmentMode === "REALTIME"}
          onChange={(v) => void setAiRefineEnabled(v)}
        />
      </Row>

      {/* 输出方式：逐字 vs 一次粘贴 + 是否复制到剪贴板 */}
      <SectionTitle>{t("section.output")}</SectionTitle>
      <Row
        label={t("output.streaming_inject.label")}
        hint={t("output.streaming_inject.hint")}
      >
        <Switch
          checked={dictation.streamingInject}
          onChange={(v) => void setDictationStreamingInject(v)}
        />
      </Row>
      <Row
        label={t("output.clipboard_copy.label")}
        hint={t("output.clipboard_copy.hint")}
      >
        <Switch
          checked={dictation.clipboardCopy}
          onChange={(v) => void setDictationClipboardCopy(v)}
        />
      </Row>

      {!loaded ? (
        <div className="mt-6 font-mono text-xs text-te-light-gray/70">
          {t("general.loading")}
        </div>
      ) : null}
    </div>
  );
}

function AiTab() {
  const { t } = useTranslation("settings");
  const aiRefine = useSettingsStore((s) => s.aiRefine);
  const setAiRefineMode = useSettingsStore((s) => s.setAiRefineMode);
  const addAiProvider = useSettingsStore((s) => s.addAiProvider);
  const updateAiProvider = useSettingsStore((s) => s.updateAiProvider);
  const removeAiProvider = useSettingsStore((s) => s.removeAiProvider);
  const setActiveAiProvider = useSettingsStore((s) => s.setActiveAiProvider);
  const setAiSystemPrompt = useSettingsStore((s) => s.setAiSystemPrompt);
  const setAiTranslationSystemPrompt = useSettingsStore(
    (s) => s.setAiTranslationSystemPrompt,
  );
  const setAiPolishSystemPrompt = useSettingsStore(
    (s) => s.setAiPolishSystemPrompt,
  );
  const setAiMeetingSummaryPrompt = useSettingsStore(
    (s) => s.setAiMeetingSummaryPrompt,
  );
  const setPolishScenarios = useSettingsStore((s) => s.setPolishScenarios);
  const setAiIncludeHistory = useSettingsStore((s) => s.setAiIncludeHistory);

  return (
    <div>
      <SectionTitle>{t("ai.section_mode")}</SectionTitle>
      <div className="py-3">
        <RadioBlock
          value={aiRefine.mode}
          onChange={(v) => void setAiRefineMode(v)}
          options={[
            {
              value: "saas",
              label: t("ai.mode_saas_label"),
              hint: t("ai.mode_saas_hint"),
            },
            {
              value: "custom",
              label: t("ai.mode_custom_label"),
              hint: t("ai.mode_custom_hint"),
            },
          ]}
        />
      </div>

      {aiRefine.mode === "custom" && (
        <>
          <SectionTitle>{t("ai.section_providers")}</SectionTitle>
          {aiRefine.customProviders.length === 0 ? (
            <div className="border border-dashed border-te-gray/40 px-4 py-6 text-center font-mono text-xs text-te-light-gray">
              {t("ai.providers_empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {aiRefine.customProviders.map((p) => (
                <AiProviderCard
                  key={p.id}
                  provider={p}
                  isActive={p.id === aiRefine.activeCustomProviderId}
                  onUpdate={(patch) => void updateAiProvider(p.id, patch)}
                  onRemove={() => void removeAiProvider(p.id)}
                  onSetActive={() => void setActiveAiProvider(p.id)}
                />
              ))}
            </div>
          )}
          <div className="mt-4 flex">
            <button
              type="button"
              onClick={() => {
                const id =
                  typeof crypto !== "undefined" && "randomUUID" in crypto
                    ? crypto.randomUUID()
                    : `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                void addAiProvider({
                  id,
                  name: t("ai.provider_default_name"),
                  baseUrl: t("ai.provider_default_base_url"),
                  model: t("ai.provider_default_model"),
                });
              }}
              className="inline-flex items-center gap-2 border border-te-gray/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
            >
              <Plus className="size-3.5" />
              {t("ai.provider_add")}
            </button>
          </div>
        </>
      )}

      <AiSystemPromptSection
        refineCustom={aiRefine.customSystemPrompt}
        onRefineChange={(v) => void setAiSystemPrompt(v)}
        translationCustom={aiRefine.customTranslationSystemPrompt}
        onTranslationChange={(v) => void setAiTranslationSystemPrompt(v)}
        polishCustom={aiRefine.customPolishSystemPrompt}
        onPolishChange={(v) => void setAiPolishSystemPrompt(v)}
        polishScenarios={aiRefine.customPolishScenarios}
        onPolishScenariosChange={(v) => void setPolishScenarios(v)}
        meetingSummaryCustom={aiRefine.customMeetingSummaryPrompt}
        onMeetingSummaryChange={(v) => void setAiMeetingSummaryPrompt(v)}
      />

      <SectionTitle>{t("ai.section_history")}</SectionTitle>
      <Row
        label={t("ai.include_history")}
        hint={t("ai.include_history_hint")}
      >
        <Switch
          checked={aiRefine.includeHistory}
          onChange={(v) => void setAiIncludeHistory(v)}
        />
      </Row>
    </div>
  );
}

type PromptKind = "refine" | "translate" | "polish" | "meeting";

function previewLine(value: string, max = 64): string {
  const first = value
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean) ?? "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

function PromptRow({
  label,
  hint,
  isCustom,
  preview,
  onEdit,
}: {
  label: string;
  hint?: string;
  isCustom: boolean;
  preview: string;
  onEdit: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-center justify-between gap-4 border-b border-te-gray/30 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-sans text-sm text-te-fg">{label}</span>
          <span
            className={cn(
              "border px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.2em]",
              isCustom
                ? "border-te-accent/60 text-te-accent"
                : "border-te-gray/40 text-te-light-gray",
            )}
          >
            {isCustom
              ? t("ai.prompt_status_custom")
              : t("ai.prompt_status_default")}
          </span>
        </div>
        {hint ? (
          <div className="mt-1 font-sans text-xs text-te-light-gray/80">
            {hint}
          </div>
        ) : null}
        <div className="mt-1 truncate font-mono text-xs text-te-light-gray/80">
          {preview}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 border border-te-gray/40 bg-te-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
      >
        {t("ai.prompt_edit")}
      </button>
    </div>
  );
}

function AiSystemPromptSection({
  refineCustom,
  onRefineChange,
  translationCustom,
  onTranslationChange,
  polishCustom,
  onPolishChange,
  polishScenarios,
  onPolishScenariosChange,
  meetingSummaryCustom,
  onMeetingSummaryChange,
}: {
  refineCustom: string | null;
  onRefineChange: (value: string | null) => void;
  translationCustom: string | null;
  onTranslationChange: (value: string | null) => void;
  polishCustom: string | null;
  onPolishChange: (value: string | null) => void;
  polishScenarios: PolishScenario[] | null;
  onPolishScenariosChange: (value: PolishScenario[] | null) => void;
  meetingSummaryCustom: string | null;
  onMeetingSummaryChange: (value: string | null) => void;
}) {
  const { t } = useTranslation("settings");
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const lang = resolveLang(interfaceLang);
  const [openKind, setOpenKind] = useState<PromptKind | null>(null);

  const refineDefault = DEFAULT_AI_SYSTEM_PROMPTS[lang];
  const translateDefault = DEFAULT_AI_TRANSLATION_SYSTEM_PROMPTS[lang];
  const polishDefault = DEFAULT_AI_POLISH_SYSTEM_PROMPTS[lang];
  const meetingDefault = DEFAULT_AI_MEETING_SUMMARY_PROMPTS[lang];

  const refineValue = refineCustom ?? refineDefault;
  const translateValue = translationCustom ?? translateDefault;
  const polishValue = polishCustom ?? polishDefault;
  const meetingValue = meetingSummaryCustom ?? meetingDefault;

  return (
    <>
      <SectionTitle>{t("ai.section_prompts")}</SectionTitle>
      <div className="-mt-2 mb-2 px-1 font-mono text-[11px] leading-relaxed text-te-light-gray">
        {t("ai.prompts_hint")}
      </div>

      <PromptRow
        label={t("ai.prompt_tab_refine")}
        isCustom={refineCustom !== null}
        preview={previewLine(refineValue)}
        onEdit={() => setOpenKind("refine")}
      />
      <PromptRow
        label={t("ai.prompt_tab_translate")}
        isCustom={translationCustom !== null}
        preview={previewLine(translateValue)}
        onEdit={() => setOpenKind("translate")}
      />
      <PromptRow
        label={t("ai.prompt_tab_polish")}
        hint={t("ai.polish_row_hint")}
        isCustom={polishCustom !== null || polishScenarios !== null}
        preview={previewLine(polishValue)}
        onEdit={() => setOpenKind("polish")}
      />
      <PromptRow
        label={t("ai.prompt_tab_meeting")}
        isCustom={meetingSummaryCustom !== null}
        preview={previewLine(meetingValue)}
        onEdit={() => setOpenKind("meeting")}
      />

      <PromptEditDialog
        open={openKind === "refine"}
        onOpenChange={(v) => !v && setOpenKind(null)}
        title={t("ai.prompt_dialog_title_refine")}
        value={refineValue}
        isCustom={refineCustom !== null}
        onChange={(v) => onRefineChange(v)}
        onReset={() => onRefineChange(null)}
      />
      <PromptEditDialog
        open={openKind === "translate"}
        onOpenChange={(v) => !v && setOpenKind(null)}
        title={t("ai.prompt_dialog_title_translate")}
        value={translateValue}
        isCustom={translationCustom !== null}
        onChange={(v) => onTranslationChange(v)}
        onReset={() => onTranslationChange(null)}
      />
      <PromptEditDialog
        open={openKind === "meeting"}
        onOpenChange={(v) => !v && setOpenKind(null)}
        title={t("ai.prompt_dialog_title_meeting")}
        value={meetingValue}
        isCustom={meetingSummaryCustom !== null}
        onChange={(v) => onMeetingSummaryChange(v)}
        onReset={() => onMeetingSummaryChange(null)}
      />
      <PolishSettingsDialog
        open={openKind === "polish"}
        onOpenChange={(v) => !v && setOpenKind(null)}
        promptValue={polishValue}
        isPromptCustom={polishCustom !== null}
        onPromptChange={(v) => onPolishChange(v)}
        onPromptReset={() => onPolishChange(null)}
        scenarios={polishScenarios}
        onScenariosChange={onPolishScenariosChange}
      />
    </>
  );
}

function PromptEditDialog({
  open,
  onOpenChange,
  title,
  value,
  isCustom,
  onChange,
  onReset,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  value: string;
  isCustom: boolean;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[88vh] w-[92vw] max-w-3xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-3xl"
      >
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {title}
          </DialogTitle>
          <DialogDescription className="font-sans text-xs text-te-light-gray">
            {t("ai.prompts_hint")}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto px-5 py-5">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={16}
            className="w-full resize-y border border-te-gray/40 bg-te-surface p-3 font-mono text-xs text-te-fg outline-none transition-colors focus:border-te-accent"
          />
        </div>
        <div className="flex items-stretch border-t border-te-dialog-border">
          <button
            type="button"
            disabled={!isCustom}
            onClick={onReset}
            className="flex-1 border-r border-te-dialog-border px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors enabled:hover:bg-te-surface-hover enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("ai.prompt_reset")}
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex-1 bg-te-accent px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            {t("common:actions.done")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PolishSettingsDialog({
  open,
  onOpenChange,
  promptValue,
  isPromptCustom,
  onPromptChange,
  onPromptReset,
  scenarios,
  onScenariosChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  promptValue: string;
  isPromptCustom: boolean;
  onPromptChange: (v: string) => void;
  onPromptReset: () => void;
  scenarios: PolishScenario[] | null;
  onScenariosChange: (next: PolishScenario[] | null) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[88vh] w-[92vw] max-w-3xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-3xl"
      >
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("ai.polish_dialog_title")}
          </DialogTitle>
          <DialogDescription className="font-sans text-xs text-te-light-gray">
            {t("ai.polish_dialog_subtitle")}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto px-5 py-5">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
                {t("ai.polish_dialog_prompt_label")}
              </div>
              <div className="mt-1 font-sans text-xs text-te-light-gray/80">
                {t("ai.prompts_hint")}
              </div>
            </div>
            <button
              type="button"
              disabled={!isPromptCustom}
              onClick={onPromptReset}
              className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("ai.prompt_reset")}
            </button>
          </div>
          <textarea
            value={promptValue}
            onChange={(e) => onPromptChange(e.target.value)}
            rows={10}
            className="w-full resize-y border border-te-gray/40 bg-te-surface p-3 font-mono text-xs text-te-fg outline-none transition-colors focus:border-te-accent"
          />

          <PolishScenariosEditor
            scenarios={scenarios}
            onChange={onScenariosChange}
          />
        </div>
        <div className="flex items-stretch border-t border-te-dialog-border">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex-1 bg-te-accent px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            {t("common:actions.done")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PolishScenariosEditor({
  scenarios,
  onChange,
}: {
  scenarios: PolishScenario[] | null;
  onChange: (next: PolishScenario[] | null) => void;
}) {
  const { t } = useTranslation("settings");
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const lang = resolveLang(interfaceLang);
  const effective = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
  const isCustom = scenarios !== null;

  const updateAt = (idx: number, patch: Partial<PolishScenario>) => {
    const base = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
    const next = base.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange(next);
  };
  const removeAt = (idx: number) => {
    const base = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
    const next = base.filter((_, i) => i !== idx);
    onChange(next);
  };
  const addNew = () => {
    const base = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `scn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next: PolishScenario[] = [
      ...base,
      {
        id,
        name: t("ai.polish_scenario_default_name"),
        instruction: "",
      },
    ];
    onChange(next);
  };

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("ai.polish_scenarios_title")}
          </div>
          <div className="mt-1 font-sans text-xs text-te-light-gray/80">
            {t("ai.polish_scenarios_hint")}
          </div>
        </div>
        <button
          type="button"
          disabled={!isCustom}
          onClick={() => onChange(null)}
          className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("ai.prompt_reset")}
        </button>
      </div>

      {effective.length === 0 ? (
        <div className="border border-dashed border-te-gray/40 px-4 py-6 text-center font-mono text-xs text-te-light-gray">
          {t("ai.polish_scenarios_empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {effective.map((s, idx) => (
            <div
              key={s.id}
              className="flex flex-col gap-2 border border-te-gray/40 bg-te-surface/50 px-3 py-3"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={s.name}
                  onChange={(e) => updateAt(idx, { name: e.target.value })}
                  className="flex-1 border border-te-gray/40 bg-te-surface px-3 py-1.5 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
                />
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  className="inline-flex items-center gap-1 border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-red-400 hover:text-red-400"
                >
                  <Trash2 className="size-3" />
                  {t("ai.polish_scenario_remove")}
                </button>
              </div>
              <textarea
                value={s.instruction}
                onChange={(e) => updateAt(idx, { instruction: e.target.value })}
                rows={3}
                placeholder={t("ai.polish_scenario_instruction_placeholder") ?? ""}
                className="w-full resize-y border border-te-gray/40 bg-te-surface p-2 font-mono text-xs text-te-fg outline-none transition-colors focus:border-te-accent"
              />
            </div>
          ))}
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={addNew}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <Plus className="size-3.5" />
          {t("ai.polish_scenario_add")}
        </button>
      </div>
    </div>
  );
}

function AiProviderCard({
  provider,
  isActive,
  onUpdate,
  onRemove,
  onSetActive,
}: {
  provider: { id: string; name: string; baseUrl: string; model: string; verified?: boolean };
  isActive: boolean;
  onUpdate: (patch: Partial<{ name: string; baseUrl: string; model: string }>) => void;
  onRemove: () => void;
  onSetActive: () => void;
}) {
  const { t } = useTranslation("settings");
  const setAiProviderVerified = useSettingsStore((s) => s.setAiProviderVerified);
  const [apiKey, setApiKey] = useState<string>("");
  const [keyDirty, setKeyDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const k = await loadAiProviderKey(provider.id);
        if (!cancelled && k !== null) setApiKey(k);
      } catch (e) {
        console.warn("[ai-refine] load api key failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  const persistKey = async () => {
    if (!keyDirty) return;
    try {
      await saveAiProviderKey(provider.id, apiKey);
      setKeyDirty(false);
      // ApiKey 改了，之前的 verified 不再可信。
      if (provider.verified) {
        await setAiProviderVerified(provider.id, false);
      }
    } catch (e) {
      console.warn("[ai-refine] save api key failed:", e);
    }
  };

  const [testing, setTesting] = useState(false);
  /// 跑一次连通性测试。返回 true=测试通过，false=测试失败 / 字段缺失 / 异常。
  /// 自身负责 toast & verified 标记；调用方只需要拿 boolean 决定是否继续后续动作。
  const runTest = async (): Promise<boolean> => {
    if (testing) return false;
    setTesting(true);
    try {
      await persistKey();
      const baseUrl = (provider.baseUrl ?? "").trim();
      const model = (provider.model ?? "").trim();
      if (!baseUrl || !model) {
        toast.error(t("ai.provider_test_fail", { message: t("ai.provider_test_missing_fields") }));
        if (provider.verified) await setAiProviderVerified(provider.id, false);
        return false;
      }
      let acc = "";
      const result = await refineTextViaChatStream(
        {
          mode: "custom",
          systemPrompt: "Reply with the single word: OK.",
          userText: "ping",
          customBaseUrl: baseUrl,
          customModel: model,
          customKeyringId: `ai_provider_${provider.id}`,
        },
        (chunk) => {
          acc += chunk;
        },
      );
      const reply = (result.refinedText ?? acc).trim();
      console.info("[ai-refine][test] reply:", reply);
      void logInfo(`[ai-refine][test] provider=${provider.id} reply=${JSON.stringify(reply)}`);
      if (reply.length === 0) {
        toast.error(t("ai.provider_test_fail", { message: t("ai.provider_test_empty_reply") }));
        if (provider.verified) await setAiProviderVerified(provider.id, false);
        return false;
      }
      toast.success(t("ai.provider_test_pass"));
      await setAiProviderVerified(provider.id, true);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t("ai.provider_test_fail", { message: msg }));
      if (provider.verified) await setAiProviderVerified(provider.id, false);
      return false;
    } finally {
      setTesting(false);
    }
  };

  /// 「设为激活」语义 = 应用该供应商。verified 已通过则直接 setActive；否则自动
  /// 跑一次测试，通过才 setActive，避免把没验证的配置真的"应用"出去。
  const handleSetActive = async () => {
    if (testing) return;
    if (!provider.verified) {
      const ok = await runTest();
      if (!ok) return;
    }
    onSetActive();
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border px-4 py-3 transition-colors",
        isActive ? "border-te-accent bg-te-accent/8" : "border-te-gray/40",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn("size-2", isActive ? "bg-te-accent" : "bg-te-gray")} />
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
            {isActive ? t("ai.provider_active") : provider.id.slice(0, 8)}
          </span>
          <span
            className={cn(
              "border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]",
              provider.verified
                ? "border-te-accent/60 text-te-accent"
                : "border-amber-500/60 text-amber-500",
            )}
          >
            {provider.verified
              ? t("dictation_provider.verified_badge")
              : t("dictation_provider.unverified_badge")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isActive && (
            <button
              type="button"
              onClick={() => void handleSetActive()}
              disabled={testing}
              className="border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-fg transition-colors enabled:hover:border-te-accent enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("ai.provider_set_active")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="inline-flex items-center gap-1 border border-te-accent bg-te-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-bg transition-colors enabled:hover:bg-te-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <FlaskConical className="size-3" />
            )}
            {testing ? t("ai.provider_test_running") : t("ai.provider_test")}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-red-400 hover:text-red-400"
          >
            <Trash2 className="size-3" />
            {t("ai.provider_remove")}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <LabeledInput
          label={t("ai.provider_name")}
          value={provider.name}
          onChange={(v) => onUpdate({ name: v })}
        />
        <LabeledInput
          label={t("ai.provider_model")}
          value={provider.model}
          onChange={(v) => onUpdate({ model: v })}
        />
      </div>
      <LabeledInput
        label={t("ai.provider_base_url")}
        value={provider.baseUrl}
        onChange={(v) => onUpdate({ baseUrl: v })}
      />
      <div>
        <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
          {t("ai.provider_api_key")}
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setKeyDirty(true);
          }}
          onBlur={() => void persistKey()}
          className="w-full border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
        />
        <div className="mt-1 font-mono text-[11px] text-te-light-gray/80">
          {t("ai.provider_api_key_hint")}
        </div>
      </div>
    </div>
  );
}

function DictationProviderCard({
  provider,
  isActive,
  onUpdate,
  onRemove,
  onSetActive,
}: {
  provider: DictationCustomProvider;
  isActive: boolean;
  onUpdate: (patch: Partial<Omit<DictationCustomProvider, "id">>) => void;
  onRemove: () => void;
  onSetActive: () => void;
}) {
  const { t } = useTranslation("settings");
  const setDictationProviderVerified = useSettingsStore(
    (s) => s.setDictationProviderVerified,
  );
  // 双字段（腾讯）/ 单字段（阿里）凭证统一存为 keyring 里的 JSON。
  const [aliApiKey, setAliApiKey] = useState<string>("");
  const [tencentSecretId, setTencentSecretId] = useState<string>("");
  const [tencentSecretKey, setTencentSecretKey] = useState<string>("");
  const [credsDirty, setCredsDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const c = await loadDictationProviderCredentials(provider.id);
        if (cancelled || !c) return;
        if (c.vendor === "aliyun") setAliApiKey(c.apiKey);
        if (c.vendor === "tencent") {
          setTencentSecretId(c.secretId);
          setTencentSecretKey(c.secretKey);
        }
      } catch (e) {
        console.warn("[dictation] load credentials failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  const persistCreds = async () => {
    if (!credsDirty) return;
    try {
      const creds: DictationCredentials =
        provider.vendor === "aliyun"
          ? { vendor: "aliyun", apiKey: aliApiKey }
          : {
              vendor: "tencent",
              secretId: tencentSecretId,
              secretKey: tencentSecretKey,
            };
      await saveDictationProviderCredentials(provider.id, creds);
      setCredsDirty(false);
      // 凭证一改，之前的 verified 不再可信——强制用户再点一次"测试"。
      if (provider.verified) {
        await setDictationProviderVerified(provider.id, false);
      }
    } catch (e) {
      console.warn("[dictation] save credentials failed:", e);
    }
  };

  const [testing, setTesting] = useState(false);
  /// 跑一次连通性测试。返回 true=通过，false=失败 / 字段缺失 / 异常。
  /// 自身负责 toast & verified 标记；调用方拿 boolean 决定下一步。
  const runTest = async (): Promise<boolean> => {
    if (testing) return false;
    setTesting(true);
    try {
      // 测试前先持久化最新凭证（这样下次打开 settings 也能看到）；测试本身用内存值
      await persistCreds();
      if (provider.vendor === "aliyun") {
        if (!aliApiKey.trim()) {
          toast.error(
            t("dictation_provider.test_fail", {
              message: t("dictation_provider.test_missing_fields"),
            }),
          );
          return false;
        }
      } else {
        const missing =
          !(provider.tencentAppId ?? "").trim() ||
          !tencentSecretId.trim() ||
          !tencentSecretKey.trim();
        if (missing) {
          toast.error(
            t("dictation_provider.test_fail", {
              message: t("dictation_provider.test_missing_fields"),
            }),
          );
          return false;
        }
      }
      const result = await testDictationProvider(
        provider.vendor === "aliyun"
          ? { vendor: "aliyun", apiKey: aliApiKey }
          : {
              vendor: "tencent",
              appId: provider.tencentAppId ?? "",
              region: provider.tencentRegion ?? null,
              secretId: tencentSecretId,
              secretKey: tencentSecretKey,
              cosBucket: provider.tencentCosBucket ?? null,
            },
      );
      if (result.ok) {
        toast.success(t("dictation_provider.test_pass"));
        await setDictationProviderVerified(provider.id, true);
        return true;
      }
      const reason =
        t(`dictation_provider.test_code.${result.code}`, {
          defaultValue: result.message,
        }) || result.message;
      toast.error(t("dictation_provider.test_fail", { message: reason }));
      if (provider.verified) {
        await setDictationProviderVerified(provider.id, false);
      }
      return false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t("dictation_provider.test_fail", { message: msg }));
      if (provider.verified) {
        await setDictationProviderVerified(provider.id, false);
      }
      return false;
    } finally {
      setTesting(false);
    }
  };

  /// 「设为激活」语义 = 应用该供应商。verified 已通过则直接 setActive；否则自动
  /// 跑一次测试，通过才 setActive，避免把没验证的配置真的"应用"出去。
  const handleSetActive = async () => {
    if (testing) return;
    if (!provider.verified) {
      const ok = await runTest();
      if (!ok) return;
    }
    onSetActive();
  };

  const vendorLabel =
    provider.vendor === "tencent"
      ? t("dictation_provider.vendor_tencent")
      : t("dictation_provider.vendor_aliyun");

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border px-4 py-3 transition-colors",
        isActive ? "border-te-accent bg-te-accent/8" : "border-te-gray/40",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn("size-2", isActive ? "bg-te-accent" : "bg-te-gray")}
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
            {isActive
              ? t("dictation_provider.active_label", { vendor: vendorLabel })
              : `${vendorLabel} · ${provider.id.slice(0, 8)}`}
          </span>
          <span
            className={cn(
              "border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]",
              provider.verified
                ? "border-te-accent/60 text-te-accent"
                : "border-amber-500/60 text-amber-500",
            )}
          >
            {provider.verified
              ? t("dictation_provider.verified_badge")
              : t("dictation_provider.unverified_badge")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isActive && (
            <button
              type="button"
              onClick={() => void handleSetActive()}
              disabled={testing}
              className="border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-fg transition-colors enabled:hover:border-te-accent enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("dictation_provider.set_active")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="inline-flex items-center gap-1 border border-te-accent bg-te-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-bg transition-colors enabled:hover:bg-te-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <FlaskConical className="size-3" />
            )}
            {testing
              ? t("dictation_provider.test_running")
              : t("dictation_provider.test")}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-red-400 hover:text-red-400"
          >
            <Trash2 className="size-3" />
            {t("dictation_provider.remove")}
          </button>
        </div>
      </div>

      <LabeledInput
        label={t("dictation_provider.name_label")}
        value={provider.name}
        onChange={(v) => onUpdate({ name: v })}
      />

      {provider.vendor === "tencent" ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <LabeledInput
              label={t("dictation_provider.tencent_app_id")}
              value={provider.tencentAppId ?? ""}
              onChange={(v) => onUpdate({ tencentAppId: v })}
              required
            />
            <LabeledInput
              label={t("dictation_provider.tencent_region")}
              value={provider.tencentRegion ?? ""}
              onChange={(v) => onUpdate({ tencentRegion: v })}
              required
            />
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("dictation_provider.tencent_cos_bucket_label")}
              <RequiredMark />
            </div>
            <input
              type="text"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t("dictation_provider.tencent_cos_bucket_placeholder") ?? ""}
              value={provider.tencentCosBucket ?? ""}
              onChange={(e) => onUpdate({ tencentCosBucket: e.target.value })}
              className="w-full border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
            />
            <div className="mt-1 font-mono text-[11px] text-te-light-gray/80">
              {t("dictation_provider.tencent_cos_bucket_hint")}
            </div>
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("dictation_provider.tencent_secret_id")}
              <RequiredMark />
            </div>
            <input
              type="text"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={tencentSecretId}
              onChange={(e) => {
                setTencentSecretId(e.target.value);
                setCredsDirty(true);
              }}
              onBlur={() => void persistCreds()}
              className="w-full border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
            />
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("dictation_provider.tencent_secret_key")}
              <RequiredMark />
            </div>
            <input
              type="password"
              value={tencentSecretKey}
              onChange={(e) => {
                setTencentSecretKey(e.target.value);
                setCredsDirty(true);
              }}
              onBlur={() => void persistCreds()}
              className="w-full border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
            />
            <div className="mt-1 font-mono text-[11px] text-te-light-gray/80">
              {t("dictation_provider.tencent_credentials_hint")}
            </div>
          </div>
        </>
      ) : (
        <div>
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("dictation_provider.aliyun_api_key")}
            <RequiredMark />
          </div>
          <input
            type="password"
            value={aliApiKey}
            onChange={(e) => {
              setAliApiKey(e.target.value);
              setCredsDirty(true);
            }}
            onBlur={() => void persistCreds()}
            className="w-full border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
          />
          <div className="mt-1 font-mono text-[11px] text-te-light-gray/80">
            {t("dictation_provider.aliyun_api_key_hint")}
          </div>
        </div>
      )}
    </div>
  );
}

function RequiredMark() {
  return <span className="ml-1 text-red-400">*</span>;
}

function LabeledInput({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
        {label}
        {required ? <RequiredMark /> : null}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
      />
    </div>
  );
}

function AboutTab() {
  const { t } = useTranslation("settings");
  const { t: tFeedback } = useTranslation("feedback");
  const navigate = useNavigate();
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const openFeedback = useUIStore((s) => s.openFeedback);
  const [appVersion, setAppVersion] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<{ os: string; arch: string } | null>(null);
  // updateChannel 真源在 Rust 侧的 update-channel 文件，前端只缓存当前值用于 UI。
  // 不进 settings.ts schema 避免双源同步问题（settings.json 与 channel 文件不一致时
  // 决定 endpoints 的是 channel 文件）。
  const [updateChannel, setUpdateChannel] = useState<"stable" | "beta">("stable");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
    invoke<string>("get_update_channel")
      .then((c) => setUpdateChannel(c === "beta" ? "beta" : "stable"))
      .catch(() => {});
    invoke<{ os: string; arch: string }>("get_platform_info")
      .then((p) => setPlatformInfo({ os: p.os, arch: p.arch }))
      .catch(() => {});
  }, []);

  // os/arch 是 Rust std::env::consts 的小写常量；显示时拼成更易读的形式。
  // arm64 的 macOS 在 Rust 里是 "aarch64"，对外仍称 Apple Silicon；x86_64 直接叫 Intel。
  const platformLabel = platformInfo
    ? (() => {
        const os =
          platformInfo.os === "macos"
            ? "macOS"
            : platformInfo.os === "windows"
              ? "Windows"
              : platformInfo.os === "linux"
                ? "Linux"
                : platformInfo.os;
        const arch =
          platformInfo.os === "macos" && platformInfo.arch === "aarch64"
            ? "Apple Silicon"
            : platformInfo.os === "macos" && platformInfo.arch === "x86_64"
              ? "Intel"
              : platformInfo.arch;
        return `${os} · ${arch}`;
      })()
    : "—";

  const handleChannelChange = async (next: "stable" | "beta") => {
    if (next === updateChannel) return;
    setUpdateChannel(next);
    try {
      await invoke("set_update_channel", { channel: next });
      void logInfo(`[updater] channel switched to ${next}`);
    } catch (e) {
      void logError(
        `[updater] channel switch failed: ${String((e as Error)?.message ?? e)}`,
      );
    }
  };

  const rerunOnboarding = async () => {
    // 把 onboardingCompleted 翻回 false 并跳到 /onboarding。SettingsDialog 与
    // /settings 全屏页两种使用场景都覆盖：先关 dialog（如果开着），再 navigate。
    await setGeneral("onboardingCompleted", false);
    setSettingsOpen(false);
    navigate("/onboarding", { replace: true });
  };

  const handleCheckUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    void logInfo("[updater] about-page check start");
    try {
      const upd = await checkForUpdateForChannel();
      if (upd) {
        void logInfo(`[updater] about-page check found: ${upd.version}`);
        // 找到新版后用 toast.action 给用户「立即安装」按钮——之前只 toast.message
        // 干瞪眼，没有任何升级路径，用户必须手动去 GitHub 下 dmg。
        // installUpdateWithProgress 内部下载完替换后会显式 relaunch_app，UI 会消失。
        toast.message(i18next.t("pages:layout.tray.update_found_title"), {
          description: upd.version,
          duration: 30_000,
          action: {
            label: i18next.t("settings:about.install_now"),
            onClick: () => {
              void installUpdateWithProgress(upd, "about-page").catch(() => {
                // helper 已处理错误 toast / log
              });
            },
          },
        });
      } else {
        void logInfo("[updater] about-page check: no update");
        toast(i18next.t("pages:layout.tray.update_none"));
      }
    } catch (e) {
      void logError(
        `[updater] about-page check failed: ${String((e as Error)?.message ?? e)}`,
      );
      toast.error(i18next.t("pages:layout.tray.update_check_failed"), {
        description: String((e as Error)?.message ?? e),
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <div>
      <SectionTitle>{t("section.build")}</SectionTitle>
      <Row label={t("about.version")}>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-te-fg">
            {appVersion ? `v${appVersion}` : "—"}
          </span>
          {import.meta.env.DEV ? (
            <span className="inline-flex items-center gap-2 border border-dashed border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
              <span className="size-1.5 bg-te-light-gray" />
              {t("about.dev_build")}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void handleCheckUpdate()}
              disabled={checkingUpdate}
              className="inline-flex items-center gap-2 border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className={cn("size-1.5 bg-te-accent", checkingUpdate && "animate-pulse")} />
              {t("about.check_update")}
            </button>
          )}
        </div>
      </Row>
      <Row label={t("about.platform")}>
        <span className="font-mono text-sm text-te-fg">{platformLabel}</span>
      </Row>
      <Row label={t("about.license")}>
        <span className="font-mono text-sm text-te-fg">PolyForm Noncommercial 1.0.0</span>
      </Row>
      <Row label={t("about.source")}>
        <a
          href="https://github.com/OpenLoaf/OpenSpeech"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-sm text-te-light-gray transition-colors hover:text-te-accent"
        >
          github.com/OpenLoaf/OpenSpeech
          <ExternalLink className="size-3.5" />
        </a>
      </Row>

      <Row label={t("about.update_channel")}>
        <div className="flex items-center gap-px border border-te-gray/60">
          {(["stable", "beta"] as const).map((c) => {
            const isActive = updateChannel === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => void handleChannelChange(c)}
                className={cn(
                  "px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors",
                  isActive
                    ? "bg-te-accent text-te-bg"
                    : "bg-te-bg text-te-light-gray hover:text-te-fg",
                )}
              >
                {t(`about.update_channel_${c}`)}
              </button>
            );
          })}
        </div>
      </Row>
      <div className="-mt-2 px-1 pb-2 font-mono text-[11px] leading-relaxed text-te-light-gray">
        {t("about.update_channel_hint")}
      </div>

      <div className="flex flex-wrap items-center gap-3 py-4">
        <button
          type="button"
          onClick={() => void rerunOnboarding()}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <Rocket className="size-3.5" />
          {t("about.rerun_onboarding")}
        </button>
        <button
          type="button"
          onClick={() => {
            // 反馈弹窗会接管：关掉设置 → 开反馈 → 用户提交/取消后自动回到 ABOUT。
            openFeedback({ returnToSettingsTab: "ABOUT" });
          }}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <MessageSquare className="size-3.5" />
          {tFeedback("menu_label")}
        </button>
        <button
          type="button"
          onClick={() => {
            invoke("open_log_dir").catch((e) => {
              void logError(`open_log_dir failed: ${String(e)}`);
              toast.error(String(e));
            });
          }}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <FolderOpen className="size-3.5" />
          {t("about.open_log_dir")}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Sub-navigation                                                    */
/* ──────────────────────────────────────────────────────────────── */

function SubNav({
  tabs,
  active,
  onChange,
  actions,
}: {
  tabs: TabDef[];
  active: TabId;
  onChange: (id: TabId) => void;
  actions?: SubNavAction[];
}) {
  const isMac = detectPlatform() === "macos";
  return (
    <nav className="flex flex-col gap-px border border-te-gray/30 bg-te-surface">
      {tabs.map((t, idx) => {
        const isActive = t.id === active;
        const Icon = t.icon;
        const shortcut = isMac ? `⌘ ${idx + 1}` : `Alt + ${idx + 1}`;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              "group relative flex items-center gap-3 py-3 pr-4 pl-5 font-mono text-xs uppercase tracking-[0.2em] transition-colors",
              isActive
                ? "bg-te-surface-hover text-te-accent"
                : "text-te-light-gray hover:text-te-fg",
            )}
          >
            <span
              className={cn(
                "absolute top-0 left-0 h-full w-[2px] transition-colors",
                isActive ? "bg-te-accent" : "bg-transparent",
              )}
            />
            <Icon className="size-4 shrink-0" />
            <span>{t.label}</span>
            <span
              aria-hidden
              className={cn(
                "ml-auto pl-4 font-mono text-[10px] normal-case tracking-normal transition-colors",
                isActive
                  ? "text-te-accent/35"
                  : "text-te-light-gray/20 group-hover:text-te-light-gray/40",
              )}
            >
              {shortcut}
            </span>
          </button>
        );
      })}
      {actions?.map((a) => {
        const Icon = a.icon;
        return (
          <button
            key={a.id}
            type="button"
            onClick={a.onClick}
            className="group relative flex items-center gap-3 py-3 pr-4 pl-5 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
          >
            <span className="absolute top-0 left-0 h-full w-[2px] bg-transparent" />
            <Icon className="size-4 shrink-0" />
            <span>{a.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Shared content (used by /settings page and SettingsDialog)        */
/* ──────────────────────────────────────────────────────────────── */

export default function SettingsContent({
  initialTab = "GENERAL",
}: { initialTab?: TabId } = {}) {
  const { t } = useTranslation("settings");
  const [tab, setTab] = useState<TabId>(initialTab);
  const tabs = useTabs();

  /// 切 tab 前先看离开的 tab 是否处于 mode=custom 但 active provider 还没测试通过的状态：
  /// 是的话静默回退到 saas 并 toast，避免用户切走后真的用着一个根本不可用的供应商。
  const requestTabChange = (next: TabId) => {
    if (next === tab) return;
    const state = useSettingsStore.getState();
    const fellBack: ("dictation" | "ai")[] = [];
    if (tab === "DICTATION" && hasUnverifiedActiveDictation(state.dictation)) {
      void state.setDictationMode("saas");
      fellBack.push("dictation");
    }
    if (tab === "AI" && hasUnverifiedActiveAiRefine(state.aiRefine)) {
      void state.setAiRefineMode("saas");
      fellBack.push("ai");
    }
    if (fellBack.length > 0) {
      const which =
        fellBack.length === 2
          ? t("provider_rollback.both")
          : t(`provider_rollback.${fellBack[0]}`);
      toast.message(
        <span className="text-te-accent">{t("provider_rollback.title")}</span>,
        { description: t("provider_rollback.description", { which }) },
      );
    }
    setTab(next);
  };

  // ⌘1~5 (macOS) / Alt+1~5 (Win/Linux) 快速跳 tab。bubble 阶段绑定，让 HotkeyBinder
  // 录入态在 capture 阶段 stopImmediatePropagation 时能优先吃掉键，避免 Cmd+1 之类
  // 在录入过程中误切 tab。
  useEffect(() => {
    const isMac = detectPlatform() === "macos";
    const onKeyDown = (e: KeyboardEvent) => {
      const modOk = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey
        : e.altKey && !e.ctrlKey && !e.metaKey;
      if (!modOk || e.shiftKey) return;
      const idx = Number.parseInt(e.key, 10);
      if (Number.isNaN(idx) || idx < 1 || idx > tabs.length) return;
      e.preventDefault();
      requestTabChange(tabs[idx - 1]!.id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, tab]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      {/* Left: sub-nav — 固定，不随右侧滚动 */}
      <motion.aside
        className="flex w-full shrink-0 flex-col gap-6 overflow-y-auto border-b border-te-gray/30 p-3 md:w-60 md:border-b-0 md:border-r"
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4 }}
      >
        <SubNav tabs={tabs} active={tab} onChange={requestTabChange} />
      </motion.aside>

      {/* Right: tab content — 独立滚动；不再额外嵌套框，避免 Dialog 内 surface 半透明叠加造成的视觉模糊 */}
      <motion.div
        key={tab}
        className="min-w-0 min-h-0 flex-1 overflow-y-auto px-5 py-4"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        {tab === "GENERAL" && <GeneralTab />}
        {tab === "HOTKEYS" && <HotkeysTab />}
        {tab === "DICTATION" && <DictationTab />}
        {tab === "AI" && <AiTab />}
        {tab === "ABOUT" && <AboutTab />}
      </motion.div>
    </div>
  );
}
