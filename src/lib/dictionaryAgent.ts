// 同步字典维护 Agent：history.updateText 写完 DB 后直接调用本函数。
// 不走 emit/listen 事件——直接函数调用更可见可调。
//
// 命中 add / update / delete 时弹 toast 提示用户"AI 自动改了字典"；noop 不弹。
// 全程容错：任何失败 console.warn 后 swallow，不抛回 updateText（保存动作不能因
// agent 失败回滚）。

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import i18n from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import {
  DICT_LIMIT,
  useDictionaryStore,
  type DictEntry,
} from "@/stores/dictionary";

const DICT_PROMPT_LIMIT = 200;

export interface RunAgentPayload {
  historyId: string;
  baseline: string;
  edited: string | null;
}

interface AgentInput {
  baseline: string;
  edited: string;
  dictionary: { id: string; term: string; aliases: string[] }[];
  historyId: string;
}

interface AgentResult {
  plan: string;
  model: string;
}

interface DecisionAdd {
  action: "add";
  term: string;
  aliases?: string[];
  reason?: string;
}
interface DecisionUpdate {
  action: "update";
  id: string;
  addAliases?: string[];
  term?: string;
  reason?: string;
}
interface DecisionDelete {
  action: "delete";
  id: string;
  reason?: string;
}
interface DecisionNoop {
  action: "noop";
  reason?: string;
}
type Decision = DecisionAdd | DecisionUpdate | DecisionDelete | DecisionNoop;

interface PlanShape {
  decisions?: Decision[];
}

export async function runDictionaryAgent(p: RunAgentPayload): Promise<void> {
  // 撤销编辑（edited === null）不触发 agent——没有"修正方向"可学。
  if (p.edited === null) return;

  const baseline = p.baseline.trim();
  const edited = p.edited.trim();
  if (!baseline || !edited) return;
  if (baseline === edited) return;

  if (!useAuthStore.getState().isAuthenticated) {
    console.debug("[dict-agent] skip: not authenticated");
    return;
  }

  const dict = useDictionaryStore.getState().entries;
  const enabled = dict.filter((e) => e.enabled).slice(0, DICT_PROMPT_LIMIT);

  const input: AgentInput = {
    baseline,
    edited,
    dictionary: enabled.map((e) => ({
      id: e.id,
      term: e.term,
      aliases: e.aliases,
    })),
    historyId: p.historyId,
  };

  let result: AgentResult;
  try {
    result = await invoke<AgentResult>("analyze_dictionary_correction", {
      input,
    });
  } catch (e) {
    console.warn("[dict-agent] invoke failed:", e);
    return;
  }

  let plan: PlanShape;
  try {
    plan = JSON.parse(result.plan) as PlanShape;
  } catch (e) {
    console.warn("[dict-agent] plan JSON parse failed:", e, result.plan);
    return;
  }
  const decisions = Array.isArray(plan.decisions) ? plan.decisions : [];
  console.info(
    "[dict-agent] plan decisions=%o (model=%s, history=%s)",
    decisions,
    result.model,
    p.historyId,
  );
  if (decisions.length === 0) return;

  for (const d of decisions) {
    try {
      const entries = useDictionaryStore.getState().entries;
      const outcome = await applyDecision(d, entries);
      console.info("[dict-agent] applied:", d.action, outcome);
      if (outcome) {
        emitToast(outcome);
      }
    } catch (e) {
      console.warn("[dict-agent] apply decision failed:", d, e);
    }
  }
}

interface ApplyOutcome {
  kind: "added" | "updated" | "removed";
  term: string;
}

async function applyDecision(
  d: Decision,
  entries: DictEntry[],
): Promise<ApplyOutcome | null> {
  switch (d.action) {
    case "noop":
      return null;
    case "add": {
      const term = d.term?.trim().replace(/\s+/g, " ");
      if (!term) return null;
      const lower = term.toLowerCase();
      const existing = entries.find((e) => e.term.toLowerCase() === lower);
      if (existing) {
        const newAliases = (d.aliases ?? [])
          .map((a) => a.trim())
          .filter((a) => a && a.toLowerCase() !== lower);
        const merged = mergeAliases(existing.aliases, newAliases);
        if (merged.length === existing.aliases.length) return null;
        await useDictionaryStore.getState().update(existing.id, {
          aliases: merged,
        });
        return { kind: "updated", term: existing.term };
      }
      if (entries.length >= DICT_LIMIT) {
        console.warn("[dict-agent] dict full, skip add:", term);
        return null;
      }
      const cleanAliases = (d.aliases ?? [])
        .map((a) => a.trim())
        .filter((a) => a && a.toLowerCase() !== lower);
      const created = await useDictionaryStore.getState().add({
        term,
        aliases: cleanAliases,
        source: "auto",
        enabled: true,
        created_by: "agent",
      });
      return { kind: "added", term: created.term };
    }
    case "update": {
      if (!d.id) return null;
      const cur = entries.find((e) => e.id === d.id);
      if (!cur) return null;
      const additions = (d.addAliases ?? [])
        .map((a) => a.trim())
        .filter((a) => a && a.toLowerCase() !== cur.term.toLowerCase());
      const renamed =
        d.term && d.term.trim() && d.term.trim() !== cur.term
          ? d.term.trim()
          : null;
      if (additions.length === 0 && !renamed) return null;
      const nextAliases = additions.length
        ? mergeAliases(cur.aliases, additions)
        : cur.aliases;
      const patch: { aliases?: string[]; term?: string } = {};
      if (nextAliases.length !== cur.aliases.length) patch.aliases = nextAliases;
      if (renamed) patch.term = renamed;
      if (Object.keys(patch).length === 0) return null;
      await useDictionaryStore.getState().update(cur.id, patch);
      return { kind: "updated", term: renamed ?? cur.term };
    }
    case "delete": {
      if (!d.id) return null;
      const cur = entries.find((e) => e.id === d.id);
      if (!cur) return null;
      await useDictionaryStore.getState().remove(cur.id);
      return { kind: "removed", term: cur.term };
    }
    default:
      console.warn(
        "[dict-agent] unknown action:",
        (d as { action: string }).action,
      );
      return null;
  }
}

function emitToast(outcome: ApplyOutcome): void {
  const baseKey = `pages:history.edit.toast.dict_${outcome.kind}`;
  const description = i18n.t("pages:history.edit.toast.dict_hint");
  // 用主色调 te-accent，不走 sonner.success 的绿色——这是"AI 自动学习"提示，
  // 视觉上当成 brand event 而非 generic success。
  // description 必须走 !text-current：sonner 在 dark theme 下把 [data-description]
  // 颜色硬编码为亮灰 hsl(0,0%,91%)，在 te-accent 黄底上看不清，强制继承 te-accent-fg。
  toast(i18n.t(baseKey, { term: outcome.term }), {
    description,
    duration: 4000,
    style: {
      background: "var(--te-accent)",
      color: "var(--te-accent-fg)",
      borderColor: "var(--te-accent)",
    },
    classNames: {
      description: "!text-current opacity-80",
    },
  });
}

function mergeAliases(prev: string[], adds: string[]): string[] {
  const seen = new Set(prev.map((a) => a.toLowerCase()));
  const out = [...prev];
  for (const a of adds) {
    const key = a.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}
