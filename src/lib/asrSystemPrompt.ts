// 语音处理（ASR / refine）的 system_prompt 组装。
//
// ASR 阶段（OL-TL-003 asrShort）和 refine 阶段（chat completions）共用同一份组装逻辑——
// 区别只在 corePrompt：ASR 用本文件的 ASR_CORE_RULES（短规则、专注偏置），refine 用
// `getEffectiveAiSystemPrompt(...)`（长规则、专注文本清洗）。其余 Domains / HotWords /
// ConversationHistory / MessageContext / TargetApp 五段格式两边完全一致。
//
// 故意不从 @/stores/history 直接 import：history store 的 retry 路径会调本文件，
// 反向依赖会触发模块循环初始化。调用方传 items 进来即可。

import i18n, { resolveLang, type SupportedLang } from "@/i18n";
import { getHotwordsArray } from "@/lib/hotwordsCache";
import { getDomainEntriesForPrompt } from "@/lib/domains";
import { DOMAIN_KEYWORDS, TRENDING_KEYWORDS } from "@/lib/domainKeywords";
import { getMachineInfoCached } from "@/lib/machineInfo";
import { useSettingsStore } from "@/stores/settings";
import type { HistoryItem } from "@/stores/history";

export const ASR_CORE_RULES: Record<SupportedLang, string> = {
  "zh-CN": `<role>
你是语音识别偏置助手。任务：让 ASR 在下方上下文影响下，**忠实还原用户原话**。
</role>

<rules>
- 利用 <system-tag> 中的 Domains / HotWords / Trending / ConversationHistory / TargetApp 偏向识别同音的专有名词、术语、人名、产品名。
- 不要改写、清洗、补全或翻译；保留口语停顿、语气词、重复。后续模块负责文本整理。
- 数字、时间、单位按说出的形式输出。
- 上下文仅作识别参考；当音频与上下文冲突时，以音频实际内容为准。
</rules>`,
  "zh-TW": `<role>
你是語音辨識偏置助手。任務：讓 ASR 在下方脈絡影響下，**忠實還原使用者原話**。
</role>

<rules>
- 利用 <system-tag> 中的 Domains / HotWords / Trending / ConversationHistory / TargetApp 偏向辨識同音的專有名詞、術語、人名、產品名。
- 不要改寫、清洗、補全或翻譯；保留口語停頓、語氣詞、重複。後續模組負責文字整理。
- 數字、時間、單位按說出的形式輸出。
- 脈絡僅作辨識參考；當音訊與脈絡衝突時，以音訊實際內容為準。
</rules>`,
  en: `<role>
You bias an upstream ASR. Task: faithfully transcribe what the speaker actually said, using the context below to disambiguate similar-sounding words.
</role>

<rules>
- Use Domains / HotWords / Trending / ConversationHistory / TargetApp in the <system-tag> blocks to bias toward proper nouns, terms, names, and products that sound alike.
- Do NOT rewrite, clean up, complete, or translate. Keep fillers, hesitations, and repetitions; downstream modules will tidy the text.
- Output numbers, times, and units exactly as spoken.
- Context is a hint only. When audio conflicts with context, trust the audio.
</rules>`,
};

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

// Rust 给的 OS 字符串归一为 "macOS / Windows / Linux"，对上游 LLM 比 "macos" 更友好。
function normalizePlatform(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("mac") || s.includes("darwin")) return "macOS";
  if (s.includes("win")) return "Windows";
  if (s.includes("linux")) return "Linux";
  return raw || "Unknown";
}

export interface BuildSpeechSystemPromptOpts {
  /** 顶部的角色 / 规则块。ASR 用 ASR_CORE_RULES[lang]，refine 用 effective AI refine system prompt。 */
  corePrompt: string;
  items: HistoryItem[];
  targetApp?: string | null;
  /** retry 路径下排除被重试的那条记录自身。 */
  excludeHistoryId?: string;
  /** 翻译 phase 2 用：phase 1 已把历史融入 refined 结果，phase 2 强制不带历史块。 */
  skipHistory?: boolean;
  /** 本次录音的音频时长（ms）。已知就传，让模型分辨"短指令 vs 长段落"。 */
  audioDurationMs?: number;
  /** 录音开始瞬间的前台窗口标题。retry 路径没有焦点快照，传 undefined 即可。 */
  focusTitle?: string | null;
  /**
   * Domains 段是否展开为"领域名: 高频术语清单"——仅 ASR (OL-TL-003) 需要，给上游做
   * 同音偏置；refine（chat）路径只需领域名，模型自己理解，不传或传 false 节省 token。
   */
  expandDomainKeywords?: boolean;
  /**
   * ConversationHistory 是否把"用户修正前 → 修正后"成对喂给上游。仅 ASR (OL-TL-003)
   * 路径需要——让模型把"用户已经纠过一次的错"作为同音偏置；refine 只需"修正后"的最终
   * 文本作为上下文，不需要原始 ASR 错词。
   *
   * 仅当条目有 text_edited 且基线长度 ≤ MAX_CORRECTION_BASELINE_LEN 时才输出 pair；
   * 长文本场景下原始内容噪声太大，回落到只显示修正后版本。
   */
  includeUserCorrections?: boolean;
}

/** 输出"修正前 → 修正后"对时，对基线长度的上限——超过就退化成只输出修正后版本。 */
const MAX_CORRECTION_BASELINE_LEN = 60;

function formatAudioDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec - m * 60);
  return `${m}m ${s}s`;
}

/**
 * 拼出语音处理阶段的 system_prompt。组成顺序：
 *   1. corePrompt
 *   2. <system-tag type="Domains">       领域偏置
 *   3. <system-tag type="HotWords">      用户词典里启用的术语
 *   4. <system-tag type="ConversationHistory">  最近 N 条同 target_app 历史
 *   5. <system-tag type="MessageContext">       requestTime + platform + appLanguage + dictationLanguage + systemLocale
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
export function buildSpeechSystemPrompt(
  opts: BuildSpeechSystemPromptOpts,
): string {
  const aiSettings = useSettingsStore.getState().aiRefine;
  const general = useSettingsStore.getState().general;
  const appLang = resolveLang(general.interfaceLang);

  const sections: string[] = [];
  if (opts.corePrompt.trim().length > 0) sections.push(opts.corePrompt);

  const domainEntries = getDomainEntriesForPrompt(aiSettings.selectedDomains);
  if (domainEntries.length > 0) {
    if (opts.expandDomainKeywords) {
      // ASR 路径：每个领域展开为"领域名: 关键词1, 关键词2, ..."一行，让上游 ASR 拿到
      // 同音偏置目标（API / JWT / 桂枝 这种容易被识别成同音中文 / 错字的术语）。
      const lines = domainEntries.map((e) => {
        const kws = DOMAIN_KEYWORDS[e.id] ?? [];
        return kws.length > 0 ? `${e.name}: ${kws.join(", ")}` : e.name;
      });
      sections.push(
        `<system-tag type="Domains">\n\t${lines.join("\n\t")}\n</system-tag>`,
      );
    } else {
      // refine 路径：只放领域名，模型自己理解领域风格；省 token + cache 友好。
      sections.push(
        `<system-tag type="Domains">\n\t${domainEntries
          .map((e) => e.name)
          .join("、")}\n</system-tag>`,
      );
    }
  }

  // Trending：跨领域的近期热门专有名词，独立于用户的 selectedDomains。仅 ASR 路径出，
  // refine 不需要——chat 模型已经"知道" Claude / Cursor 这些产品名，再给它列一遍纯属
  // 灌 cache miss + 无收益。
  if (opts.expandDomainKeywords && TRENDING_KEYWORDS.length > 0) {
    sections.push(
      `<system-tag type="Trending">\n\t${TRENDING_KEYWORDS.join(", ")}\n</system-tag>`,
    );
  }

  const hotwords = getHotwordsArray();
  if (hotwords.length > 0) {
    sections.push(
      `<system-tag type="HotWords">\n\t${hotwords.join("、")}\n</system-tag>`,
    );
  }

  if (aiSettings.includeHistory && !opts.skipHistory) {
    const target = (opts.targetApp ?? "").trim();
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
      .slice(0, Math.max(1, aiSettings.recentHistoryCount ?? 10))
      .reverse()
      .map((it) => {
        // 基线 = 用户改前看到的"AI 给的最终版"；text_edited 存在 = 用户手动改过。
        // 优先取修正后版本；没编辑过则回落 refined_text → 原始 ASR text。
        const baseline = (it.refined_text ?? it.text ?? "").trim();
        const editedRaw = (it.text_edited ?? "").trim();
        const hasCorrection = editedRaw.length > 0 && editedRaw !== baseline;
        const content = hasCorrection ? editedRaw : baseline;
        if (!content) return "";
        const showPair =
          opts.includeUserCorrections &&
          hasCorrection &&
          baseline.length > 0 &&
          baseline.length <= MAX_CORRECTION_BASELINE_LEN;
        const mins = Math.max(1, Math.floor((now - it.created_at) / 60000));
        // target 已知时整段已是同一 app，targetApp 提到了 tag attribute 上，每行只剩
        // focusTitle（同 app 不同窗口/任务的偏置）。target 未知时段内可能跨 app，回落到
        // 行内 `targetApp=` 标记保证模型能区分。
        const focus = (it.focus_title ?? "").trim();
        const itemApp = (it.target_app ?? "").trim();
        const meta: string[] = [];
        if (!target && itemApp) meta.push(`targetApp=${itemApp}`);
        if (focus) meta.push(`focusTitle=${focus}`);
        // ASR 路径下用户修过的条目，把"原 ASR 错词"以 correctedFrom 标记附在 meta 上，
        // 让模型把成对样本作为同音偏置：下次听到类似音应输出 content（修正后）而非原词。
        // baseline 内含 `"` 时转义，避免 attribute 引号断裂。
        if (showPair) {
          meta.push(`correctedFrom="${baseline.replace(/"/g, "&quot;")}"`);
        }
        const head =
          meta.length > 0
            ? `[${mins} ${minutesAgoLabel} · ${meta.join(" · ")}]`
            : `[${mins} ${minutesAgoLabel}]`;
        return `${head} ${content}`;
      })
      .filter((s) => s.length > 0);
    if (lines.length > 0) {
      const tagOpen = target
        ? `<system-tag type="ConversationHistory" targetApp="${target}">`
        : `<system-tag type="ConversationHistory">`;
      sections.push(`${tagOpen}\n\t${lines.join("\n\n\t")}\n</system-tag>`);
    }
  }

  const machine = getMachineInfoCached();
  const ctxLines: string[] = [
    `requestTime: ${formatLocalRequestTime()}`,
    `platform: ${normalizePlatform(machine.os)}`,
    `appLanguage: ${appLang}`,
  ];
  if (machine.deviceName) ctxLines.push(`deviceName: ${machine.deviceName}`);
  if (machine.hostname && machine.hostname !== machine.deviceName) {
    ctxLines.push(`hostname: ${machine.hostname}`);
  }
  if (machine.username) ctxLines.push(`username: ${machine.username}`);
  if (typeof opts.audioDurationMs === "number" && opts.audioDurationMs > 0) {
    ctxLines.push(`audioDuration: ${formatAudioDuration(opts.audioDurationMs)}`);
  }
  sections.push(
    `<system-tag type="MessageContext">\n\t${ctxLines.join("\n\t")}\n</system-tag>`,
  );

  // TargetApp：聚焦应用本身的所有信息收一起。focusTitle（含文件名 / 联系人 / 任务）
  // 比 name 信号强很多——retry 路径没有焦点快照时只剩 name。
  const targetParts: string[] = [];
  const app = (opts.targetApp ?? "").trim();
  if (app.length > 0) targetParts.push(`name: ${app}`);
  const focusTitle = (opts.focusTitle ?? "").trim();
  if (focusTitle.length > 0) targetParts.push(`focusTitle: ${focusTitle}`);
  if (targetParts.length > 0) {
    sections.push(
      `<system-tag type="TargetApp">\n\t${targetParts.join("\n\t")}\n</system-tag>`,
    );
  }

  return sections.join("\n\n").trim();
}
