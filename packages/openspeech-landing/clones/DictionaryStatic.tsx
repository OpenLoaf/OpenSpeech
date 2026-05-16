import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  Camera,
  Car,
  Clapperboard,
  Code2,
  Feather,
  GraduationCap,
  Leaf,
  Megaphone,
  Palette,
  Pencil,
  Scale,
  Search,
  Shield,
  Stethoscope,
  Trash2,
  TrendingUp,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * src/pages/Dictionary/index.tsx 的 Header + Filters + Grid + 新增 Dialog 高保真克隆。
 * className 与真实页面逐句对齐；store / i18n 已剥离，词条与领域用本地 mock。
 */

const DOMAIN_IDS = [
  "programming",
  "ai_ml",
  "cybersecurity",
  "design",
  "film_production",
  "photography",
  "marketing",
  "finance",
  "law",
  "academic",
  "medicine",
  "tcm",
  "psychology",
  "engineering",
  "automotive",
] as const;
type DomainId = (typeof DOMAIN_IDS)[number];

const DOMAIN_ICONS: Record<DomainId, LucideIcon> = {
  programming: Code2,
  ai_ml: Bot,
  medicine: Stethoscope,
  law: Scale,
  finance: TrendingUp,
  academic: GraduationCap,
  engineering: Wrench,
  marketing: Megaphone,
  psychology: Brain,
  design: Palette,
  film_production: Clapperboard,
  cybersecurity: Shield,
  photography: Camera,
  tcm: Leaf,
  automotive: Car,
};

// 与 zh-CN/pages.json 的 dictionary.domains.items 对齐
const DOMAIN_NAMES: Record<DomainId, string> = {
  programming: "软件开发",
  ai_ml: "AI / 机器学习",
  cybersecurity: "网络安全",
  design: "设计创意",
  film_production: "影视制作",
  photography: "摄影",
  marketing: "营销增长",
  finance: "金融投资",
  law: "法律",
  academic: "学术科研",
  medicine: "医学健康",
  tcm: "中医",
  psychology: "心理学",
  engineering: "工程制造",
  automotive: "汽车",
};

const DOMAIN_LIMIT = 3;

interface DictEntry {
  id: string;
  term: string;
  aliases: string[];
}

// 14 条覆盖：公司名 / AI 工具 / 同事英文名 / 中医 + 法律 + 程序员各 1 条
const INITIAL_ENTRIES: DictEntry[] = [
  { id: "e1", term: "Baidu", aliases: ["百度", "白度"] },
  { id: "e2", term: "Anthropic", aliases: ["安特罗皮", "安瑟罗皮克"] },
  { id: "e3", term: "OpenAI", aliases: ["欧本爱"] },
  { id: "e4", term: "ByteDance", aliases: ["字节跳动", "拜登舞"] },
  { id: "e5", term: "Claude", aliases: ["克劳德", "克拉乌德"] },
  { id: "e6", term: "Cursor", aliases: ["可瑟", "光标"] },
  { id: "e7", term: "Tauri", aliases: ["塔乌里"] },
  { id: "e8", term: "K8s", aliases: ["Kubernetes", "k 八"] },
  { id: "e9", term: "Notion", aliases: ["闹神"] },
  { id: "e10", term: "LeAngelo", aliases: ["莱安杰罗", "李昂哥"] },
  { id: "e11", term: "Benedict", aliases: ["本尼迪克特"] },
  { id: "e12", term: "肝郁气滞", aliases: ["gan yu qi zhi"] },
  { id: "e13", term: "举证责任倒置", aliases: ["反向举证"] },
  { id: "e14", term: "幂等键", aliases: ["idempotency key", "幂等 key"] },
];

type FilterKey = "all" | "domains" | "manual";
const FILTERS: FilterKey[] = ["all", "domains", "manual"];

const FILTER_LABEL: Record<FilterKey, string> = {
  all: "全部",
  domains: "常见领域",
  manual: "手动添加",
};

export function DictionaryStatic() {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [selectedDomains, setSelectedDomains] = useState<DomainId[]>([
    "programming",
    "ai_ml",
    "design",
  ]);
  const [entries, setEntries] = useState<DictEntry[]>(INITIAL_ENTRIES);
  const [newOpen, setNewOpen] = useState(false);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (!q) return true;
      if (e.term.toLowerCase().includes(q)) return true;
      return e.aliases.some((a) => a.toLowerCase().includes(q));
    });
  }, [entries, query]);

  const filteredDomains = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return selectedDomains;
    return selectedDomains.filter((id) =>
      DOMAIN_NAMES[id].toLowerCase().includes(q),
    );
  }, [selectedDomains, query]);

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const toggleDomain = (id: DomainId) => {
    setSelectedDomains((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= DOMAIN_LIMIT) return prev;
      return [...prev, id];
    });
  };

  const addEntry = (term: string) => {
    const normalized = term.trim().replace(/\s+/g, " ");
    if (!normalized) return false;
    if (entries.some((e) => e.term.toLowerCase() === normalized.toLowerCase()))
      return false;
    setEntries((prev) => [
      { id: `e-${Date.now()}`, term: normalized, aliases: [] },
      ...prev,
    ]);
    return true;
  };

  return (
    <section className="relative flex h-[640px] flex-col overflow-hidden bg-te-bg">
      {/* Header */}
      <div className="shrink-0 border-b border-te-gray/30 bg-te-bg">
        <div className="mx-auto max-w-5xl px-[4vw] pt-3 pb-[clamp(1rem,2vw,2rem)]">
          <motion.div
            className="flex items-start justify-between gap-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <div>
              <h1 className="font-mono text-3xl font-bold tracking-tighter text-te-fg">
                词典
              </h1>
              <p className="mt-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
                自定义词汇 · 最多 2,000 条
              </p>
            </div>

            <motion.button
              type="button"
              onClick={() => setNewOpen(true)}
              className="shrink-0 bg-te-accent px-4 py-2 font-mono text-xs uppercase tracking-wider text-te-accent-fg transition-[filter] hover:brightness-110"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              + 新词
            </motion.button>
          </motion.div>
        </div>
      </div>

      {/* Filters + SearchBox */}
      <div className="shrink-0 border-b border-te-gray/40 bg-te-bg">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-[4vw] py-2">
          <div className="flex items-center gap-1">
            {FILTERS.map((key) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`relative flex items-center gap-1.5 px-3 py-2 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
                    active
                      ? "text-te-accent"
                      : "text-te-light-gray hover:text-te-fg"
                  }`}
                >
                  <span>{FILTER_LABEL[key]}</span>
                  {active ? (
                    <motion.span
                      layoutId="dict-filter-underline"
                      className="absolute inset-x-0 -bottom-[9px] h-[2px] bg-te-accent"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <SearchBoxClone value={query} onChange={setQuery} />
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-[4vw] py-[clamp(1rem,2vw,2rem)]">
          {filter === "domains" ? (
            <DomainPicker
              selected={selectedDomains}
              onToggle={toggleDomain}
            />
          ) : (
            <DictionaryGrid
              filter={filter}
              entries={filteredEntries}
              selectedDomains={filteredDomains}
              onDeleteEntry={removeEntry}
              onRemoveDomain={toggleDomain}
            />
          )}
        </div>
      </div>

      <NewWordDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onAdd={addEntry}
        existingTerms={entries.map((e) => e.term.toLowerCase())}
      />
    </section>
  );
}

/* ---------------- SearchBox（克隆 src/components/SearchBox.tsx） ---------------- */

function SearchBoxClone({
  value,
  onChange,
  width = 224,
}: {
  value: string;
  onChange: (v: string) => void;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const collapse = () => {
    onChange("");
    setOpen(false);
  };

  const handleBlur = () => {
    if (!value) setOpen(false);
  };

  return (
    <div className="relative flex items-center">
      <AnimatePresence initial={false} mode="wait">
        {open ? (
          <motion.div
            key="input"
            className="relative flex items-center"
            initial={{ width: 28, opacity: 0 }}
            animate={{ width, opacity: 1 }}
            exit={{ width: 28, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-te-light-gray" />
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={(e) => {
                if (e.key === "Escape") collapse();
              }}
              placeholder="搜索词条..."
              className="h-8 w-full border border-te-gray/40 bg-te-surface pr-7 pl-8 font-mono text-xs tracking-wider text-te-fg uppercase placeholder:text-te-light-gray focus:border-te-accent focus:outline-none"
            />
            {value && (
              <button
                type="button"
                onClick={collapse}
                className="absolute right-1.5 inline-flex size-5 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
                aria-label="清空搜索"
              >
                <X className="size-3" />
              </button>
            )}
          </motion.div>
        ) : (
          <motion.button
            key="btn"
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex size-8 items-center justify-center border border-te-gray/40 text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            aria-label="搜索"
            title="搜索"
          >
            <Search className="size-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------- Domain Picker (domains tab) ---------------- */

function DomainPicker({
  selected,
  onToggle,
}: {
  selected: DomainId[];
  onToggle: (id: DomainId) => void;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const atLimit = selected.length >= DOMAIN_LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-te-light-gray">
        <span>勾选你常聊的领域，AI 会优先按这些场景调整术语和措辞</span>
        <span>
          已选 {selected.length} / {DOMAIN_LIMIT}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {DOMAIN_IDS.map((id, index) => {
          const Icon = DOMAIN_ICONS[id];
          const active = selectedSet.has(id);
          const disabled = !active && atLimit;
          return (
            <motion.button
              key={id}
              type="button"
              onClick={() => onToggle(id)}
              disabled={disabled}
              title={disabled ? `最多选 ${DOMAIN_LIMIT} 个` : undefined}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: Math.min(index * 0.02, 0.2) }}
              className={`group flex items-center gap-3 border px-3 py-2.5 transition-colors ${
                active
                  ? "border-te-accent bg-te-accent/10 text-te-accent"
                  : disabled
                    ? "cursor-not-allowed border-te-gray/30 bg-te-surface/40 text-te-light-gray/40"
                    : "border-te-gray/40 bg-te-surface text-te-fg hover:border-te-accent hover:text-te-accent"
              }`}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left font-mono text-sm font-bold tracking-tight">
                {DOMAIN_NAMES[id]}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Mixed Grid (all / manual tabs) ---------------- */

function DictionaryGrid({
  filter,
  entries,
  selectedDomains,
  onDeleteEntry,
  onRemoveDomain,
}: {
  filter: "all" | "manual";
  entries: DictEntry[];
  selectedDomains: DomainId[];
  onDeleteEntry: (id: string) => void;
  onRemoveDomain: (id: DomainId) => void;
}) {
  const showDomains = filter === "all" && selectedDomains.length > 0;
  const totalCount = entries.length + (showDomains ? selectedDomains.length : 0);

  if (totalCount === 0) {
    return (
      <motion.div
        className="mt-16 text-center font-mono text-sm uppercase tracking-[0.3em] text-te-light-gray"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
      >
        // 暂无词条 //
      </motion.div>
    );
  }

  const showDivider = showDomains && entries.length > 0;

  return (
    <>
      {showDomains ? (
         <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
           <AnimatePresence mode="popLayout">
             {selectedDomains.map((id, index) => (
               <DomainCard
                 key={`domain-${id}`}
                 id={id}
                 index={index}
                 onRemove={() => onRemoveDomain(id)}
               />
             ))}
           </AnimatePresence>
         </div>
      ) : null}

      {showDivider ? (
        <div className="my-6 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
          <span className="h-px flex-1 bg-te-gray/40" />
          <span>自定义词条</span>
          <span className="h-px flex-1 bg-te-gray/40" />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        <AnimatePresence mode="popLayout">
          {entries.map((entry, index) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              index={index}
              onDelete={() => onDeleteEntry(entry.id)}
            />
          ))}
        </AnimatePresence>
      </div>

      <div className="mt-10 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
        // 共 {String(totalCount).padStart(3, "0")} 条 //
      </div>
    </>
  );
}

/* ---------------- New Word Dialog（NewWordDialog 视觉克隆） ---------------- */

function NewWordDialog({
  open,
  onOpenChange,
  onAdd,
  existingTerms,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (term: string) => boolean;
  existingTerms: string[];
}) {
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 切换关闭时清空状态
  useEffect(() => {
    if (!open) {
      setTerm("");
      setError(null);
    }
  }, [open]);

  const submit = () => {
    const normalized = term.trim().replace(/\s+/g, " ");
    if (!normalized) {
      setError("term 不能为空");
      return;
    }
    if (existingTerms.includes(normalized.toLowerCase())) {
      setError("该词条已存在");
      return;
    }
    const ok = onAdd(normalized);
    if (ok) onOpenChange(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="overlay"
            className="absolute inset-0 z-30 bg-black/60 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            key="dialog"
            className="absolute inset-0 z-40 flex items-center justify-center px-6"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="!gap-0 w-full max-w-md border border-te-gray bg-te-bg p-0 shadow-2xl">
              <div className="border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
                <h3 className="font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
                  新词
                </h3>
              </div>

              <div className="flex flex-col gap-4 px-4 py-5">
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
                    term <span className="text-te-accent">*</span>
                  </span>
                  <input
                    autoFocus
                    type="text"
                    value={term}
                    onChange={(e) => {
                      setTerm(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit();
                      if (e.key === "Escape") onOpenChange(false);
                    }}
                    placeholder="例如 OpenSpeech"
                    className="border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg placeholder:text-te-light-gray focus:border-te-accent focus:outline-none"
                  />
                </label>

                {error && (
                  <div className="font-mono text-[11px] uppercase tracking-wider text-[#ff4d4d]">
                    {error}
                  </div>
                )}
              </div>

              <div className="flex flex-row justify-end gap-2 border-t border-te-gray/40 bg-te-surface-hover px-4 py-3">
                <motion.button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="border border-te-gray/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                >
                  取消
                </motion.button>
                <motion.button
                  type="button"
                  onClick={submit}
                  className="bg-te-accent px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-te-accent-fg transition-[filter] hover:brightness-110"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                >
                  添加
                </motion.button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ---------------- Cards ---------------- */

function DomainCard({
  id,
  index,
  onRemove,
}: {
  id: DomainId;
  index: number;
  onRemove: () => void;
}) {
  const Icon = DOMAIN_ICONS[id];
  return (
    <motion.article
      className="group flex items-center gap-3 border border-te-accent/60 bg-te-accent/10 px-3 py-2.5 text-te-accent transition-all hover:border-te-accent"
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={{ y: -2, boxShadow: "0 4px 20px rgba(0, 200, 140, 0.15)" }}
      whileTap={{ scale: 0.98 }}
      viewport={{ once: true }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.02, 0.2) }}
    >
      <span className="shrink-0" title="常用领域">
        <Icon className="size-3.5" />
      </span>
      <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-bold tracking-tight">
        {DOMAIN_NAMES[id]}
      </h3>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
         <motion.button
           type="button"
           aria-label="删除"
           title="删除"
           onClick={onRemove}
           className="inline-flex size-6 items-center justify-center transition-colors hover:text-te-fg"
           whileHover={{ scale: 1.1 }}
           whileTap={{ scale: 0.9 }}
         >
           <Trash2 className="size-3.5" />
         </motion.button>
      </div>
    </motion.article>
  );
}

function EntryCard({
  entry,
  index,
  onDelete,
}: {
  entry: DictEntry;
  index: number;
  onDelete: () => void;
}) {
  const tip = entry.aliases.length
    ? `${entry.term} · ${entry.aliases.join(" · ")}`
    : entry.term;

  return (
    <motion.article
      className="group flex items-center gap-3 border border-te-gray/40 bg-te-surface px-3 py-2.5 transition-all hover:border-te-accent"
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={{ y: -2, boxShadow: "0 4px 20px rgba(0, 0, 0, 0.1)" }}
      whileTap={{ scale: 0.98 }}
      exit={{ opacity: 0, scale: 0.9, x: -10 }}
      viewport={{ once: true }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.02, 0.2) }}
    >
      <span className="shrink-0 text-te-light-gray" title="手动添加">
        <Feather className="size-3.5" />
      </span>

      <h3
        title={tip}
        className="min-w-0 flex-1 truncate font-mono text-sm font-bold tracking-tight text-te-fg"
      >
        {entry.term}
      </h3>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <motion.button
          type="button"
          aria-label="编辑"
          title="编辑"
          className="inline-flex size-6 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
        >
          <Pencil className="size-3.5" />
        </motion.button>
        <motion.button
          type="button"
          aria-label="删除"
          title="删除"
          onClick={onDelete}
          className="inline-flex size-6 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
        >
          <Trash2 className="size-3.5" />
        </motion.button>
      </div>
    </motion.article>
  );
}
