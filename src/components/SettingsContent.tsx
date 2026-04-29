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
import { useSettingsStore } from "@/stores/settings";
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
  User2,
  Sliders,
  Sparkles,
  Info,
  Rocket,
  MessageSquare,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { syncAutostart } from "@/lib/autostart";
import {
  checkForUpdateForChannel,
  installUpdateWithProgress,
} from "@/lib/updaterInstall";
import { HotkeyField } from "@/components/HotkeyField";
import { useHotkeysStore } from "@/stores/hotkeys";
import {
  BINDING_IDS,
  findConflict,
  type BindingId,
  type HotkeyBinding,
} from "@/lib/hotkey";
import { detectPlatform } from "@/lib/platform";

/* ──────────────────────────────────────────────────────────────── */
/*  Types                                                             */
/* ──────────────────────────────────────────────────────────────── */

import type { SettingsTabId } from "@/stores/ui";
type TabId = SettingsTabId;

type TabDef = {
  id: TabId;
  label: string;
  icon: typeof User2;
};

type SubNavAction = {
  id: string;
  label: string;
  icon: typeof User2;
  onClick: () => void;
};

function useTabs(): TabDef[] {
  const { t } = useTranslation("settings");
  return [
    { id: "ACCOUNT", label: t("tabs.account"), icon: User2 },
    { id: "GENERAL", label: t("tabs.general"), icon: Sliders },
    { id: "PERSONALIZATION", label: t("tabs.personalization"), icon: Sparkles },
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
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "relative flex h-[22px] w-10 items-center rounded-sm border transition-colors",
        checked
          ? "border-te-accent bg-te-accent"
          : "border-te-gray/60 bg-te-gray",
      )}
      aria-pressed={checked}
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

function SegButton<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-stretch border border-te-gray/40 bg-te-surface">
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "px-3 py-2 font-mono text-xs uppercase tracking-[0.15em] transition-colors",
              i !== 0 && "border-l border-te-gray/40",
              active
                ? "bg-te-accent/8 text-te-accent"
                : "text-te-light-gray hover:text-te-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
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
/*  Hotkeys section                                                   */
/* ──────────────────────────────────────────────────────────────── */

const UNDO_WINDOW_MS = 8000;

function HotkeysSection() {
  const { t } = useTranslation("settings");
  const bindings = useHotkeysStore((s) => s.bindings);
  const setBinding = useHotkeysStore((s) => s.setBinding);
  const recordUndo = useHotkeysStore((s) => s.recordUndo);

  const commitChange = async (
    id: BindingId,
    newValue: HotkeyBinding | null,
  ) => {
    const conflictId =
      newValue && findConflict(bindings, newValue, id);
    if (conflictId) {
      const replacedOld = bindings[conflictId];
      await setBinding(conflictId, null);
      await setBinding(id, newValue);
      await recordUndo({
        replacedId: conflictId,
        oldValue: replacedOld,
        changedId: id,
        newValue,
        expiresAt: Date.now() + UNDO_WINDOW_MS,
      });
      return;
    }
    await setBinding(id, newValue);
  };

  const handleCheckConflict = (candidate: HotkeyBinding, excludeId: BindingId) =>
    findConflict(bindings, candidate, excludeId);

  return (
    <div className="flex flex-col">
      <div className="mb-3 border border-te-gray/40 bg-te-surface/60 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-accent">
          {t("hotkeys.how_it_works")}
        </div>
        <div className="mt-1.5 font-sans text-xs leading-relaxed text-te-light-gray">
          {t("hotkeys.how_it_works_body")}
        </div>
      </div>

      <div className="divide-y divide-te-gray/30">
        {BINDING_IDS.map((id) => (
          <HotkeyField
            key={id}
            id={id}
            value={bindings[id]}
            onChange={(v) => void commitChange(id, v)}
            onConflictCheck={(c) => handleCheckConflict(c, id)}
            // 听写至少保留一个可用绑定：不允许清空
            canClear={id !== "dictate_ptt"}
          />
        ))}
      </div>
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

    const device = general.inputDevice || null;
    void startAudioLevel(device);

    // 若 20Hz tick 意外丢失，peak 会卡住；每 150ms 衰减避免"卡住点亮"。
    peakDecayTimer.current = window.setInterval(() => {
      setPeak((p) => (p > 0.02 ? p * 0.6 : 0));
    }, 150) as unknown as number;

    return () => {
      cancelled = true;
      unlisten?.();
      void stopAudioLevel();
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
      {/* Keyboard shortcuts */}
      <SectionTitle>{t("section.shortcuts")}</SectionTitle>
      <HotkeysSection />

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
      <Row label={t("general.dictation_lang")}>
        <Select
          value={general.dictationLang}
          onChange={(v) => void setGeneral("dictationLang", v)}
          options={[
            { value: "自动检测", label: t("common:value.auto_detect") },
            { value: "ZH", label: "ZH" },
            { value: "EN", label: "EN" },
            { value: "JA", label: "JA" },
          ]}
        />
      </Row>

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

      {/* Dictation mode */}
      <SectionTitle>{t("section.asr_segment")}</SectionTitle>
      <div className="py-3">
        <RadioBlock
          value={general.asrSegmentMode}
          onChange={(v) => void setGeneral("asrSegmentMode", v)}
          options={[
            {
              value: "REALTIME",
              label: t("asr_segment.realtime_label"),
              hint: t("asr_segment.realtime_hint"),
            },
            {
              value: "UTTERANCE",
              label: t("asr_segment.utterance_label"),
              hint: t("asr_segment.utterance_hint"),
            },
            {
              value: "AI_REFINE",
              label: t("asr_segment.ai_refine_label"),
              hint: t("asr_segment.ai_refine_hint"),
            },
          ]}
        />
      </div>

      {/* Text injection */}
      <SectionTitle>{t("section.text_injection")}</SectionTitle>
      <Row
        label={t("general.restore_clipboard")}
        hint={t("general.restore_clipboard_hint")}
      >
        <Switch
          checked={general.restoreClipboard}
          onChange={(v) => void setGeneral("restoreClipboard", v)}
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
        label={t("general.auto_update")}
        hint={t("general.auto_update_hint")}
      >
        <Switch
          checked={general.autoUpdate}
          onChange={(v) => void setGeneral("autoUpdate", v)}
        />
      </Row>

      {/* History */}
      <SectionTitle>{t("section.history")}</SectionTitle>
      <Row
        label={t("general.history_retention")}
        hint={t("general.history_retention_hint")}
      >
        <Select
          value={general.historyRetention}
          onChange={(v) => void setGeneral("historyRetention", v)}
          options={[
            { value: "forever", label: t("general.history_retention_options.forever") },
            { value: "90d", label: t("general.history_retention_options.90d") },
            { value: "30d", label: t("general.history_retention_options.30d") },
            { value: "7d", label: t("general.history_retention_options.7d") },
            { value: "off", label: t("general.history_retention_options.off") },
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

function PersonalizationTab() {
  const { t } = useTranslation("settings");
  const personalization = useSettingsStore((s) => s.personalization);
  const setPersonalization = useSettingsStore((s) => s.setPersonalization);

  return (
    <div>
      <SectionTitle>{t("section.ai_enhance")}</SectionTitle>
      <Row
        label={t("personalization.auto_polish")}
        hint={t("personalization.auto_polish_hint")}
      >
        <Switch
          checked={personalization.autoPolish}
          onChange={(v) => void setPersonalization("autoPolish", v)}
        />
      </Row>
      <Row
        label={t("personalization.context_style")}
        hint={t("personalization.context_style_hint")}
      >
        <Switch
          checked={personalization.contextStyle}
          onChange={(v) => void setPersonalization("contextStyle", v)}
        />
      </Row>

      <SectionTitle>{t("section.dictionary_learning")}</SectionTitle>
      <Row
        label={t("personalization.sensitivity")}
        hint={t("personalization.sensitivity_hint")}
      >
        <SegButton
          value={personalization.sensitivity}
          onChange={(v) => void setPersonalization("sensitivity", v)}
          options={[
            { value: "LOW", label: t("personalization.low") },
            { value: "NORMAL", label: t("personalization.normal") },
            { value: "HIGH", label: t("personalization.high") },
          ]}
        />
      </Row>
    </div>
  );
}

function AccountTab() {
  const { t } = useTranslation("settings");
  return (
    <div>
      <SectionTitle>{t("section.identity")}</SectionTitle>
      <Row label={t("account.email")}>
        <span className="font-mono text-sm text-te-fg">
          dynamicoct@gmail.com
        </span>
      </Row>
      <Row label={t("account.subscription")} hint={t("account.subscription_hint")}>
        <span className="inline-flex items-center gap-2 border border-te-accent/60 bg-te-accent/8 px-3 py-1 font-mono text-xs uppercase tracking-[0.15em] text-te-accent">
          <span className="size-1.5 bg-te-accent" />
          {t("account.free_byo_badge")}
        </span>
      </Row>

      <SectionTitle>{t("section.session")}</SectionTitle>
      <div className="py-4">
        <button
          type="button"
          className="w-full border border-te-gray px-5 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent md:w-auto md:min-w-[16rem]"
        >
          {t("account.sign_out")}
        </button>
        <p className="mt-3 font-sans text-xs text-te-light-gray">
          {t("account.sign_out_hint")}
        </p>
      </div>
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
  // updateChannel 真源在 Rust 侧的 update-channel 文件，前端只缓存当前值用于 UI。
  // 不进 settings.ts schema 避免双源同步问题（settings.json 与 channel 文件不一致时
  // 决定 endpoints 的是 channel 文件）。
  const [updateChannel, setUpdateChannel] = useState<"stable" | "beta">("stable");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
    invoke<string>("get_update_channel")
      .then((c) => setUpdateChannel(c === "beta" ? "beta" : "stable"))
      .catch(() => {});
  }, []);

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

  const deps = [
    { name: "Tauri", version: "2.x" },
    { name: "React", version: "19" },
    { name: "Tailwind CSS", version: "v4" },
    { name: "cpal", version: "audio i/o" },
    { name: "enigo", version: "planned" },
    { name: "framer-motion", version: "latest" },
  ];

  return (
    <div>
      <SectionTitle>{t("section.build")}</SectionTitle>
      <Row label={t("about.version")}>
        <span className="font-mono text-sm text-te-fg">
          {appVersion ? `v${appVersion}` : "—"}
        </span>
      </Row>
      <Row label={t("about.license")}>
        <span className="font-mono text-sm text-te-fg">MIT</span>
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
          onClick={() => void handleCheckUpdate()}
          disabled={checkingUpdate}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className={cn("size-1.5 bg-te-accent", checkingUpdate && "animate-pulse")} />
          {t("about.check_update")}
        </button>
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
            // feedback 弹窗与设置 Dialog 不并存——关掉设置再开反馈
            setSettingsOpen(false);
            openFeedback();
          }}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <MessageSquare className="size-3.5" />
          {tFeedback("menu_label")}
        </button>
        <button
          type="button"
          onClick={() => void invoke("open_log_dir")}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <FolderOpen className="size-3.5" />
          {t("about.open_log_dir")}
        </button>
      </div>

      <SectionTitle>{t("section.third_party")}</SectionTitle>
      <div className="grid grid-cols-1 gap-px border border-te-gray/30 bg-te-gray/30 md:grid-cols-2">
        {deps.map((d) => (
          <div
            key={d.name}
            className="flex items-center justify-between bg-te-bg px-4 py-3"
          >
            <span className="font-mono text-sm text-te-fg">{d.name}</span>
            <span className="font-mono text-xs text-te-light-gray">
              {d.version}
            </span>
          </div>
        ))}
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
  return (
    <nav className="flex flex-col gap-px border border-te-gray/30 bg-te-surface">
      {tabs.map((t) => {
        const isActive = t.id === active;
        const Icon = t.icon;
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
  const [tab, setTab] = useState<TabId>(initialTab);
  const tabs = useTabs();

  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      {/* Left: sub-nav — 固定，不随右侧滚动 */}
      <motion.aside
        className="flex w-full shrink-0 flex-col gap-6 overflow-y-auto border-b border-te-gray/30 p-3 md:w-60 md:border-b-0 md:border-r"
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4 }}
      >
        <SubNav tabs={tabs} active={tab} onChange={setTab} />
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
        {tab === "PERSONALIZATION" && <PersonalizationTab />}
        {tab === "ACCOUNT" && <AccountTab />}
        {tab === "ABOUT" && <AboutTab />}
      </motion.div>
    </div>
  );
}
