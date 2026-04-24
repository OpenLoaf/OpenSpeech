import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Feather, Pencil, Sparkles, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchBox } from "@/components/SearchBox";

type Source = "manual" | "auto";

interface DictEntry {
  id: string;
  term: string;
  aliases?: string[];
  source: Source;
}

type FilterKey = "all" | "auto" | "manual";

const SEED_ENTRIES: DictEntry[] = [
  {
    id: "t-01",
    term: "OpenSpeech",
    aliases: ["open speech", "open-speech"],
    source: "manual",
  },
  { id: "t-02", term: "Tauri", source: "manual" },
  { id: "t-03", term: "cpal", source: "manual" },
  { id: "t-04", term: "enigo", source: "manual" },
  {
    id: "t-05",
    term: "shadcn/ui",
    aliases: ["shadcn ui", "shad-cn"],
    source: "manual",
  },
  { id: "t-06", term: "TypeLess", source: "auto" },
  { id: "t-07", term: "Whisper", source: "auto" },
  { id: "t-08", term: "Deepgram", source: "manual" },
  { id: "t-09", term: "SQLite", source: "manual" },
  { id: "t-10", term: "Keychain", source: "manual" },
  { id: "t-11", term: "ydotool", source: "auto" },
  { id: "t-12", term: "Wayland", source: "manual" },
];

const FILTERS: { key: FilterKey; label: string; Icon?: typeof Sparkles }[] = [
  { key: "all", label: "全部" },
  { key: "auto", label: "自动添加", Icon: Sparkles },
  { key: "manual", label: "手动添加", Icon: Feather },
];

export default function DictionaryPage() {
  const [entries, setEntries] = useState<DictEntry[]>(SEED_ENTRIES);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);

  const addEntry = (term: string) =>
    setEntries((prev) => [
      {
        id: `t-${Date.now().toString(36)}`,
        term,
        source: "manual",
      },
      ...prev,
    ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== "all" && e.source !== filter) return false;
      if (!q) return true;
      if (e.term.toLowerCase().includes(q)) return true;
      return e.aliases?.some((a) => a.toLowerCase().includes(q)) ?? false;
    });
  }, [entries, filter, query]);

  const removeEntry = (id: string) =>
    setEntries((prev) => prev.filter((e) => e.id !== id));

  return (
    <section className="flex h-full flex-col bg-te-bg">
      {/* 顶部固定区：标题 + 新词按钮（可拖窗，按钮豁免） */}
      <div
        data-tauri-drag-region
        className="shrink-0 border-b border-te-gray/30 bg-te-bg"
      >
        <div
          data-tauri-drag-region
          className="mx-auto max-w-5xl px-[4vw] py-[clamp(1rem,2vw,2rem)]"
        >
          <motion.div
            data-tauri-drag-region
            className="flex items-start justify-between gap-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <div data-tauri-drag-region>
              <h1 className="font-mono text-3xl font-bold tracking-tighter text-te-fg">
                词典
              </h1>
              <p className="mt-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
                自定义词汇 · 最多 2,000 条
              </p>
            </div>

            <button
              type="button"
              data-tauri-drag-region="false"
              onClick={() => setNewOpen(true)}
              className="shrink-0 bg-te-accent px-4 py-2 font-mono text-xs uppercase tracking-wider text-te-accent-fg transition-[filter] hover:brightness-110"
            >
              + 新词
            </button>
          </motion.div>
        </div>
      </div>

      {/* 中部固定区：Tabs + 搜索框 */}
      <div className="shrink-0 border-b border-te-gray/40 bg-te-bg">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-[4vw] py-2">
          <div className="flex items-center gap-1">
            {FILTERS.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`relative flex items-center gap-1.5 px-3 py-2 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
                    active ? "text-te-accent" : "text-te-light-gray hover:text-te-fg"
                  }`}
                >
                  {f.Icon ? <f.Icon className="size-3.5" /> : null}
                  <span>{f.label}</span>
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

          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="搜索词条..."
          />
        </div>
      </div>

      {/* 滚动区：网格无限滚动 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-[4vw] py-[clamp(1rem,2vw,2rem)]">
          {filtered.length === 0 ? (
            <motion.div
              className="mt-16 text-center font-mono text-sm uppercase tracking-[0.3em] text-te-light-gray"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
            >
              // 暂无词条 //
            </motion.div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                {filtered.map((entry, index) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    index={index}
                    onDelete={() => removeEntry(entry.id)}
                  />
                ))}
              </div>

              <div className="mt-10 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
                // 共 {filtered.length.toString().padStart(3, "0")} 条 //
              </div>
            </>
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

/* ---------------- New Word Dialog ---------------- */

interface NewWordDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (term: string) => void;
  existingTerms: string[];
}

function NewWordDialog({
  open,
  onOpenChange,
  onAdd,
  existingTerms,
}: NewWordDialogProps) {
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTerm("");
    setError(null);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

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
    onAdd(normalized);
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="!gap-0 rounded-none border border-te-gray bg-te-bg p-0 sm:max-w-md">
        <DialogHeader className="border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <DialogTitle className="font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
            新词
          </DialogTitle>
          <DialogDescription className="sr-only">
            添加自定义词典条目
          </DialogDescription>
        </DialogHeader>

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

        <DialogFooter className="flex flex-row justify-end gap-2 border-t border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            className="border border-te-gray/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            className="bg-te-accent px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-te-accent-fg transition-[filter] hover:brightness-110"
          >
            添加
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Entry Card ---------------- */

interface EntryCardProps {
  entry: DictEntry;
  index: number;
  onDelete: () => void;
}

function EntryCard({ entry, index, onDelete }: EntryCardProps) {
  const tip = entry.aliases?.length
    ? `${entry.term} · ${entry.aliases.join(" · ")}`
    : entry.term;

  return (
    <motion.article
      className="group flex items-center gap-3 border border-te-gray/40 bg-te-surface px-3 py-2.5 transition-colors hover:border-te-accent"
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.02, 0.2) }}
    >
      <span
        className="shrink-0 text-te-light-gray"
        title={entry.source === "auto" ? "自动添加" : "手动添加"}
      >
        {entry.source === "auto" ? (
          <Sparkles className="size-3.5" />
        ) : (
          <Feather className="size-3.5" />
        )}
      </span>

      <h3
        title={tip}
        className="min-w-0 flex-1 truncate font-mono text-sm font-bold tracking-tight text-te-fg"
      >
        {entry.term}
      </h3>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label="编辑"
          title="编辑"
          className="inline-flex size-6 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="删除"
          title="删除"
          onClick={onDelete}
          className="inline-flex size-6 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </motion.article>
  );
}
