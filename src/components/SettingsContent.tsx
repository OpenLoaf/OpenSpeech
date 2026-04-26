import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import { SECRET_STT_API_KEY, getSecret, setSecret } from "@/lib/secrets";
import {
  listInputDevices,
  startAudioLevel,
  stopAudioLevel,
  type InputDeviceInfo,
} from "@/lib/audio";
import {
  ChevronDown,
  Eye,
  EyeOff,
  ExternalLink,
  User2,
  Sliders,
  Sparkles,
  Info,
  Cloud,
  Rocket,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { syncAutostart } from "@/lib/autostart";
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

const TABS: TabDef[] = [
  { id: "ACCOUNT", label: "账户", icon: User2 },
  { id: "GENERAL", label: "通用", icon: Sliders },
  { id: "MODEL", label: "模型", icon: Cloud },
  { id: "PERSONALIZATION", label: "个性化", icon: Sparkles },
  { id: "ABOUT", label: "关于", icon: Info },
];

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

function TextInput({
  value,
  onChange,
  onBlur,
  type = "text",
  placeholder,
  className,
  rightSlot,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  type?: string;
  placeholder?: string;
  className?: string;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center border border-te-gray/40 bg-te-surface transition-colors focus-within:border-te-accent",
        className,
      )}
    >
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="w-full bg-transparent px-3 py-2 font-mono text-sm text-te-fg placeholder:text-te-light-gray/60 focus:outline-none"
      />
      {rightSlot ? <div className="pr-2">{rightSlot}</div> : null}
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
          // HOW IT WORKS
        </div>
        <div className="mt-1.5 font-sans text-xs leading-relaxed text-te-light-gray">
          按一下快捷键开始说话，再按一下结束并把文字插入到当前焦点。两次按下间隔 &lt; 300 ms 视为快速双击误触，本次录音丢弃。
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
          ? `跟随系统（当前：${systemDefaultName}）`
          : "跟随系统",
      },
    ];
    for (const d of devices) {
      base.push({
        value: d.name,
        label: d.isDefault ? `${d.name} · 系统默认` : d.name,
      });
    }
    // 用户曾选中、但此刻不在设备列表（拔掉耳机等）→ 追加占位项：
    // <select> 需要这条来让 value 命中，文案说清楚正在走系统默认兜底
    if (wanted && !devices.some((d) => d.name === wanted)) {
      base.push({
        value: wanted,
        label: systemDefaultName
          ? `${wanted} · 已断开，暂用系统默认（${systemDefaultName}）`
          : `${wanted} · 已断开`,
      });
    }
    return base;
  }, [devices, wanted, systemDefaultName]);

  return (
    <div>
      {/* Keyboard shortcuts */}
      <SectionTitle>键盘快捷键</SectionTitle>
      <HotkeysSection />

      {/* Language */}
      <SectionTitle>语言</SectionTitle>
      <Row label="界面语言">
        <Select
          value={general.interfaceLang}
          onChange={(v) => void setGeneral("interfaceLang", v)}
          options={["跟随系统", "简体中文", "English"]}
        />
      </Row>
      <Row label="听写语种">
        <Select
          value={general.dictationLang}
          onChange={(v) => void setGeneral("dictationLang", v)}
          options={["自动检测", "ZH", "EN", "JA"]}
        />
      </Row>
      <Row label="翻译目标">
        <Select
          value={general.translationTarget}
          onChange={(v) => void setGeneral("translationTarget", v)}
          options={["EN", "ZH", "JA"]}
        />
      </Row>
      <Row label="语言变体">
        <Select
          value={general.langVariant}
          onChange={(v) => void setGeneral("langVariant", v)}
          options={["EN-US", "EN-GB", "ZH-CN", "ZH-TW"]}
        />
      </Row>

      {/* Audio */}
      <SectionTitle>音频</SectionTitle>
      <Row label="输入设备">
        <Select
          value={general.inputDevice}
          onChange={(v) => void setGeneral("inputDevice", v)}
          className="min-w-[18rem]"
          options={deviceOptions}
        />
      </Row>
      <Row
        label="输入声音"
        hint={
          effectiveName
            ? `实时电平 · 正在监听：${effectiveName}`
            : "实时麦克风电平"
        }
      >
        <LevelMeter peak={peak} />
      </Row>
      <Row label="开始/结束提示音">
        <Switch
          checked={general.cueSound}
          onChange={(v) => void setGeneral("cueSound", v)}
        />
      </Row>

      {/* ASR segmentation */}
      <SectionTitle>分句模式</SectionTitle>
      <div className="py-3">
        <RadioBlock
          value={general.asrSegmentMode}
          onChange={(v) => void setGeneral("asrSegmentMode", v)}
          options={[
            {
              value: "AUTO",
              label: "自动分句",
              hint: "服务端按停顿自动切句，录音过程中实时回填文字。",
            },
            {
              value: "MANUAL",
              label: "手动分句",
              hint: "整段录音视为一次完整对话，松开按键后才返回转写结果。",
            },
          ]}
        />
      </div>

      {/* Text injection */}
      <SectionTitle>文本注入</SectionTitle>
      <div className="py-3">
        <RadioBlock
          value={general.injectMethod}
          onChange={(v) => void setGeneral("injectMethod", v)}
          options={[
            {
              value: "CLIPBOARD + PASTE",
              label: "剪贴板 + 粘贴",
              hint: "默认方式，快速且可靠。",
            },
            {
              value: "SIMULATE KEYBOARD",
              label: "模拟键盘",
              hint: "逐字符键入。",
            },
          ]}
        />
      </div>
      <Row
        label="粘贴后恢复剪贴板"
        hint="建议保持开启"
      >
        <Switch
          checked={general.restoreClipboard}
          onChange={(v) => void setGeneral("restoreClipboard", v)}
        />
      </Row>

      {/* Behavior */}
      <SectionTitle>行为</SectionTitle>
      <Row label="开机自启">
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
          label="在 Dock 中显示应用"
          hint="在 macOS Dock 中显示 OpenSpeech 图标，便于快速访问。关闭后应用作为纯菜单栏应用运行（仍可通过系统托盘打开主窗口）"
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
        label="悬浮录音条常驻显示"
        hint="开启后录音条始终悬浮在屏幕上（即使未录音），方便看到状态"
      >
        <Switch
          checked={general.overlayAlwaysVisible}
          onChange={(v) => void setGeneral("overlayAlwaysVisible", v)}
        />
      </Row>
      <Row
        label="关闭时最小化到托盘"
        hint="开启后关闭主窗口直接隐藏到托盘；关闭时每次弹确认对话框"
      >
        <Switch
          checked={general.closeBehavior === "HIDE"}
          onChange={(v) =>
            void setGeneral("closeBehavior", v ? "HIDE" : "ASK")
          }
        />
      </Row>
      <Row
        label="自动更新"
        hint="启动时静默检查并安装新版本；关闭后只能通过托盘「检查更新」手动触发"
      >
        <Switch
          checked={general.autoUpdate}
          onChange={(v) => void setGeneral("autoUpdate", v)}
        />
      </Row>
      {!loaded ? (
        <div className="mt-6 font-mono text-xs text-te-light-gray/70">
          // loading settings…
        </div>
      ) : null}
    </div>
  );
}

function ModelTab() {
  const general = useSettingsStore((s) => s.general);
  const setGeneral = useSettingsStore((s) => s.setGeneral);

  // API Key 不进 Zustand / plugin-store：读一次进本地 state 显示，blur / 改动时写回 keyring。
  const [apiKey, setApiKey] = useState<string>("");
  const [showKey, setShowKey] = useState(false);
  const apiKeyInitial = useRef<string>("");

  useEffect(() => {
    void (async () => {
      try {
        const v = await getSecret(SECRET_STT_API_KEY);
        const initial = v ?? "";
        apiKeyInitial.current = initial;
        setApiKey(initial);
      } catch (e) {
        console.warn("getSecret failed", e);
      }
    })();
  }, []);

  const flushApiKey = async () => {
    if (apiKey === apiKeyInitial.current) return;
    try {
      await setSecret(SECRET_STT_API_KEY, apiKey);
      apiKeyInitial.current = apiKey;
      toast.success("API Key 已保存到系统密钥链");
    } catch (e) {
      toast.error(`API Key 保存失败: ${e}`);
    }
  };

  return (
    <div>
      <SectionTitle>大模型（REST）</SectionTitle>
      <div className="mb-3 border border-te-gray/40 bg-te-surface/60 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-accent">
          // BYO-MODEL
        </div>
        <div className="mt-1.5 font-sans text-xs leading-relaxed text-te-light-gray">
          OpenSpeech 不内置模型。填写你自己的 STT REST 端点，音频会直接从本机发送到该端点；API Key 仅存于系统密钥链。
        </div>
      </div>

      <div className="space-y-3 py-2">
        <div>
          <div className="mb-1.5 font-mono text-xs uppercase tracking-[0.15em] text-te-light-gray">
            端点 URL
          </div>
          <TextInput
            value={general.endpoint}
            onChange={(v) => void setGeneral("endpoint", v)}
            className="w-full"
            placeholder="https://..."
          />
        </div>
        <div>
          <div className="mb-1.5 font-mono text-xs uppercase tracking-[0.15em] text-te-light-gray">
            API Key
            <span className="ml-2 text-[10px] tracking-normal text-te-light-gray/70 normal-case">
              存储于系统密钥链；失去焦点时自动保存
            </span>
          </div>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            onBlur={() => void flushApiKey()}
            type={showKey ? "text" : "password"}
            className="w-full"
            placeholder="sk-..."
            rightSlot={
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="flex size-7 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
                aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
              >
                {showKey ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            }
          />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1.5 font-mono text-xs uppercase tracking-[0.15em] text-te-light-gray">
              模型名称
            </div>
            <TextInput
              value={general.modelName}
              onChange={(v) => void setGeneral("modelName", v)}
              className="w-full"
            />
          </div>
          <div>
            <div className="mb-1.5 font-mono text-xs uppercase tracking-[0.15em] text-te-light-gray">
              请求超时（秒）
            </div>
            <TextInput
              value={general.timeout}
              onChange={(v) => void setGeneral("timeout", v)}
              type="number"
              className="w-full"
            />
          </div>
        </div>
        <div>
          <div className="mb-1.5 font-mono text-xs uppercase tracking-[0.15em] text-te-light-gray">
            音频格式
          </div>
          <Select
            value={general.audioFormat}
            onChange={(v) => void setGeneral("audioFormat", v)}
            options={["WAV", "OPUS"]}
          />
        </div>
        <div className="pt-2">
          <button
            type="button"
            className="group inline-flex items-center gap-2 border border-te-accent bg-te-accent px-5 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            <span className="size-1.5 bg-te-accent-fg" />
            测试连接
          </button>
        </div>
      </div>
    </div>
  );
}

function PersonalizationTab() {
  const personalization = useSettingsStore((s) => s.personalization);
  const setPersonalization = useSettingsStore((s) => s.setPersonalization);

  return (
    <div>
      <SectionTitle>AI 增强</SectionTitle>
      <Row
        label="AI 自动润色"
        hint="移除口头禅与口误"
      >
        <Switch
          checked={personalization.autoPolish}
          onChange={(v) => void setPersonalization("autoPolish", v)}
        />
      </Row>
      <Row
        label="上下文风格"
        hint="将前台应用名传给模型以适配语气"
      >
        <Switch
          checked={personalization.contextStyle}
          onChange={(v) => void setPersonalization("contextStyle", v)}
        />
      </Row>

      <SectionTitle>词典学习</SectionTitle>
      <Row
        label="学习灵敏度"
        hint="控制新词汇被自动收集的积极程度"
      >
        <SegButton
          value={personalization.sensitivity}
          onChange={(v) => void setPersonalization("sensitivity", v)}
          options={[
            { value: "LOW", label: "低" },
            { value: "NORMAL", label: "标准" },
            { value: "HIGH", label: "高" },
          ]}
        />
      </Row>
    </div>
  );
}

function AccountTab() {
  return (
    <div>
      <SectionTitle>身份</SectionTitle>
      <Row label="电子邮件">
        <span className="font-mono text-sm text-te-fg">
          dynamicoct@gmail.com
        </span>
      </Row>
      <Row label="订阅" hint="使用自带的模型 Key">
        <span className="inline-flex items-center gap-2 border border-te-accent/60 bg-te-accent/8 px-3 py-1 font-mono text-xs uppercase tracking-[0.15em] text-te-accent">
          <span className="size-1.5 bg-te-accent" />
          免费 / 自带模型
        </span>
      </Row>

      <SectionTitle>会话</SectionTitle>
      <div className="py-4">
        <button
          type="button"
          className="w-full border border-te-gray px-5 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent md:w-auto md:min-w-[16rem]"
        >
          退出登录
        </button>
        <p className="mt-3 font-sans text-xs text-te-light-gray">
          退出后将清除本地登录状态。本地录音、历史与词典将保留。
        </p>
      </div>
    </div>
  );
}

function AboutTab() {
  const navigate = useNavigate();
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const rerunOnboarding = async () => {
    // 把 onboardingCompleted 翻回 false 并跳到 /onboarding。SettingsDialog 与
    // /settings 全屏页两种使用场景都覆盖：先关 dialog（如果开着），再 navigate。
    await setGeneral("onboardingCompleted", false);
    setSettingsOpen(false);
    navigate("/onboarding", { replace: true });
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
      <SectionTitle>构建</SectionTitle>
      <Row label="版本">
        <span className="font-mono text-sm text-te-fg">v0.1.0</span>
      </Row>
      <Row label="许可证">
        <span className="font-mono text-sm text-te-fg">MIT</span>
      </Row>
      <Row label="源代码">
        <a
          href="https://github.com/openspeech/openspeech"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-sm text-te-light-gray transition-colors hover:text-te-accent"
        >
          github.com/openspeech/openspeech
          <ExternalLink className="size-3.5" />
        </a>
      </Row>

      <div className="flex flex-wrap items-center gap-3 py-4">
        <button
          type="button"
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <span className="size-1.5 bg-te-accent" />
          检查更新
        </button>
        <button
          type="button"
          onClick={() => void rerunOnboarding()}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <Rocket className="size-3.5" />
          重新运行首次引导
        </button>
      </div>

      <SectionTitle>第三方依赖</SectionTitle>
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
  active,
  onChange,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  return (
    <nav className="flex flex-col gap-px border border-te-gray/30 bg-te-surface">
      {TABS.map((t) => {
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      {/* Left: sub-nav — 固定，不随右侧滚动 */}
      <motion.aside
        className="flex w-full shrink-0 flex-col gap-6 overflow-y-auto border-b border-te-gray/30 p-3 md:w-60 md:border-b-0 md:border-r"
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4 }}
      >
        <SubNav active={tab} onChange={setTab} />
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
        {tab === "MODEL" && <ModelTab />}
        {tab === "PERSONALIZATION" && <PersonalizationTab />}
        {tab === "ACCOUNT" && <AccountTab />}
        {tab === "ABOUT" && <AboutTab />}
      </motion.div>
    </div>
  );
}
