// 文件转写（OL-TL-003 asrShort）的 system_prompt 组装。
// SDK ≥ 0.3.18 起在短音频路径接受 system_prompt，用于上下文偏置 / 专有名词纠偏。
//
// **不复用 AI refine 的 system prompt**：refine 那条几千字 prompt 全是文本清洗 / 书面化
// 规则，ASR 阶段不该看；这里另写一份简短的 ASR-only 偏置规则，剩余预算让给用户的 Domains
// / HotWords / ConversationHistory / TargetApp。
//
// 故意不从 @/stores/history 直接 import：history store 的 retry 路径会调本文件，
// 反向依赖会触发模块循环初始化。调用方传 items 进来即可。

import i18n, { resolveLang, type SupportedLang } from "@/i18n";
import { getHotwordsArray } from "@/lib/hotwordsCache";
import { getDomainNamesForPrompt } from "@/lib/domains";
import { useSettingsStore } from "@/stores/settings";
import type { HistoryItem } from "@/stores/history";

const HISTORY_TURNS = 5;

// 本地时间 + 时区偏移 + IANA 时区名，例：2026-05-07T22:36:55+08:00 (Asia/Shanghai)
// 用本地时间而不是 UTC——上游模型按用户所在时区理解 "今天/晚上/上午" 这类隐含线索更准。
function formatLocalRequestTime(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offMin) / 60));
  const om = pad(Math.abs(offMin) % 60);
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    tz = "";
  }
  const offset = `${sign}${oh}:${om}`;
  return tz
    ? `${Y}-${M}-${D}T${h}:${m}:${s}${offset} (${tz})`
    : `${Y}-${M}-${D}T${h}:${m}:${s}${offset}`;
}

// Tauri webview 自带 navigator，不用引 plugin-os / 走 invoke：信息够 ASR 偏置用，链路也最轻。
// 归一 platform 是为了"macOS/Windows/Linux" 这种语义化标签——上游 LLM 比 "MacIntel"/"Win32" 更好理解。
function normalizePlatform(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("mac") || s.includes("darwin")) return "macOS";
  if (s.includes("win")) return "Windows";
  if (s.includes("linux")) return "Linux";
  return raw || "Unknown";
}

interface MachineInfo {
  platform: string;
  locale: string;
  languages: string[];
}

function getMachineInfo(): MachineInfo {
  // Chromium 内核 webview 优先 userAgentData（更稳定的字符串），webkit2gtk 兜底 navigator.platform。
  // navigator.platform 在 lib.dom 标了 deprecated，但 webkit2gtk 没有 userAgentData，仍需保留——
  // 整个 navigator 走 unknown cast，让类型系统不再触发 deprecation hint。
  const nav = navigator as unknown as {
    userAgentData?: { platform?: string };
    platform?: string;
  };
  const platform = nav.userAgentData?.platform || nav.platform || "";

  let locale = "";
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
  } catch {
    locale = navigator.language ?? "";
  }

  const languages = Array.isArray(navigator.languages)
    ? navigator.languages.slice(0, 4)
    : navigator.language
      ? [navigator.language]
      : [];

  return {
    platform: normalizePlatform(platform),
    locale: locale || navigator.language || "",
    languages,
  };
}

const ASR_CORE_RULES: Record<SupportedLang, string> = {
  "zh-CN": `<role>
你是语音识别偏置助手。任务：让 ASR 在下方上下文影响下，**忠实还原用户原话**。
</role>

<rules>
- 利用 <system-tag> 中的 Domains / HotWords / ConversationHistory / TargetApp 偏向识别同音的专有名词、术语、人名、产品名。
- 不要改写、清洗、补全或翻译；保留口语停顿、语气词、重复。后续模块负责文本整理。
- 数字、时间、单位按说出的形式输出。
- 上下文仅作识别参考；当音频与上下文冲突时，以音频实际内容为准。
</rules>`,
  "zh-TW": `<role>
你是語音辨識偏置助手。任務：讓 ASR 在下方脈絡影響下，**忠實還原使用者原話**。
</role>

<rules>
- 利用 <system-tag> 中的 Domains / HotWords / ConversationHistory / TargetApp 偏向辨識同音的專有名詞、術語、人名、產品名。
- 不要改寫、清洗、補全或翻譯；保留口語停頓、語氣詞、重複。後續模組負責文字整理。
- 數字、時間、單位按說出的形式輸出。
- 脈絡僅作辨識參考；當音訊與脈絡衝突時，以音訊實際內容為準。
</rules>`,
  en: `<role>
You bias an upstream ASR. Task: faithfully transcribe what the speaker actually said, using the context below to disambiguate similar-sounding words.
</role>

<rules>
- Use Domains / HotWords / ConversationHistory / TargetApp in the <system-tag> blocks to bias toward proper nouns, terms, names, and products that sound alike.
- Do NOT rewrite, clean up, complete, or translate. Keep fillers, hesitations, and repetitions; downstream modules will tidy the text.
- Output numbers, times, and units exactly as spoken.
- Context is a hint only. When audio conflicts with context, trust the audio.
</rules>`,
};

export interface BuildAsrSystemPromptOpts {
  items: HistoryItem[];
  targetApp?: string | null;
  /** retry 路径下排除被重试的那条记录自身。 */
  excludeHistoryId?: string;
}

/**
 * 拼出给 OL-TL-003 的 system_prompt。组成顺序：
 *   1. ASR-only core rules（按 UI 语言三语挑一份）
 *   2. <system-tag type="Domains">       领域偏置
 *   3. <system-tag type="HotWords">      用户词典里启用的术语
 *   4. <system-tag type="ConversationHistory">  最近 N 条同 target_app 历史
 *   5. <system-tag type="MessageContext">       requestTime
 *   6. <system-tag type="TargetApp">     当前注入目标应用
 *
 * 与 aiRefine.enabled **解耦**：refine.enabled 只控制录音结束后是否做文本清洗，跟 ASR
 * 阶段是否带识别偏置无关。即使关掉 AI 优化（直接落原文），ASR 阶段仍会带 system_prompt。
 *
 * `aiRefine.includeHistory = false` ⇒ 不带历史块；其余偏置块照常带。
 *
 * 长度：SDK changelog 建议 ≤ 2000 字。这里**不主动截断**，让 Rust 侧打日志暴露真实长度，
 * 用户自行决定是否精简。截断会让"说了半句被砍"的现象隐性发生，反而更难调。
 */
export function buildAsrSystemPrompt(
  opts: BuildAsrSystemPromptOpts,
): string | undefined {
  const aiSettings = useSettingsStore.getState().aiRefine;
  const general = useSettingsStore.getState().general;
  const lang = resolveLang(general.interfaceLang);

  const sections: string[] = [ASR_CORE_RULES[lang]];

  const domains = getDomainNamesForPrompt(aiSettings.selectedDomains);
  if (domains.length > 0) {
    sections.push(
      `<system-tag type="Domains">\n\t${domains.join("、")}\n</system-tag>`,
    );
  }

  const hotwords = getHotwordsArray();
  if (hotwords.length > 0) {
    sections.push(
      `<system-tag type="HotWords">\n\t${hotwords.join("、")}\n</system-tag>`,
    );
  }

  if (aiSettings.includeHistory) {
    const target = opts.targetApp ?? null;
    const minutesAgoLabel = i18n.t("ai.minutes_ago", {
      ns: "settings",
      defaultValue: "minutes ago",
    });
    const now = Date.now();
    const lines = opts.items
      .filter(
        (it) =>
          (!opts.excludeHistoryId || it.id !== opts.excludeHistoryId) &&
          it.status === "success",
      )
      .filter((it) => !target || it.target_app === target)
      .slice(0, HISTORY_TURNS)
      .reverse()
      .map((it) => {
        const content = (it.refined_text ?? it.text ?? "").trim();
        if (!content) return "";
        const mins = Math.max(1, Math.floor((now - it.created_at) / 60000));
        return `[${mins} ${minutesAgoLabel}] ${content}`;
      })
      .filter((s) => s.length > 0);
    if (lines.length > 0) {
      sections.push(
        `<system-tag type="ConversationHistory">\n\t${lines.join("\n\n\t")}\n</system-tag>`,
      );
    }
  }

  const machine = getMachineInfo();
  const machineLines = [
    `platform: ${machine.platform}`,
    machine.locale ? `locale: ${machine.locale}` : "",
    machine.languages.length > 0
      ? `languages: ${machine.languages.join(", ")}`
      : "",
  ].filter((s) => s.length > 0);
  if (machineLines.length > 0) {
    sections.push(
      `<system-tag type="MachineInfo">\n\t${machineLines.join("\n\t")}\n</system-tag>`,
    );
  }

  const requestTime = formatLocalRequestTime();
  sections.push(
    `<system-tag type="MessageContext">\n\trequestTime: ${requestTime}\n</system-tag>`,
  );

  const app = (opts.targetApp ?? "").trim();
  if (app.length > 0) {
    sections.push(
      `<system-tag type="TargetApp">\n\tname: ${app}\n</system-tag>`,
    );
  }

  return sections.join("\n\n").trim();
}
