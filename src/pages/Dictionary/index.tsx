import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Feather, Pencil, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchBox } from "@/components/SearchBox";
import { useDictionaryStore, type DictEntry } from "@/stores/dictionary";
import { useSettingsStore } from "@/stores/settings";
import {
  DOMAIN_ICONS,
  DOMAIN_IDS,
  DOMAIN_LIMIT,
  isDomainId,
  type DomainId,
} from "@/lib/domains";

type FilterKey = "all" | "domains" | "manual";

const FILTERS: FilterKey[] = ["all", "domains", "manual"];

export default function DictionaryPage() {
  const { t } = useTranslation();
  const entries = useDictionaryStore((s) => s.entries);
  const addToDb = useDictionaryStore((s) => s.add);
  const removeFromDb = useDictionaryStore((s) => s.remove);
  const selectedDomains = useSettingsStore((s) => s.aiRefine.selectedDomains);
  const setSelectedDomains = useSettingsStore((s) => s.setSelectedDomains);

  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);

  const validSelected = useMemo<DomainId[]>(
    () => selectedDomains.filter(isDomainId),
    [selectedDomains],
  );

  const addEntry = async (term: string) => {
    await addToDb({ term });
  };

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
    if (!q) return validSelected;
    return validSelected.filter((id) =>
      t(`pages:dictionary.domains.items.${id}`).toLowerCase().includes(q),
    );
  }, [validSelected, query, t]);

  const removeEntry = async (id: string) => {
    await removeFromDb(id);
  };

  const toggleDomain = async (id: DomainId) => {
    const exists = validSelected.includes(id);
    let next: DomainId[];
    if (exists) {
      next = validSelected.filter((x) => x !== id);
    } else {
      if (validSelected.length >= DOMAIN_LIMIT) return;
      next = [...validSelected, id];
    }
    await setSelectedDomains(next);
  };

  return (
    <section className="flex h-full flex-col bg-te-bg">
      <div
        data-tauri-drag-region
        className="shrink-0 border-b border-te-gray/30 bg-te-bg"
      >
        <div
          data-tauri-drag-region
          className="mx-auto max-w-5xl px-[4vw] pt-3 pb-[clamp(1rem,2vw,2rem)]"
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
                {t("pages:dictionary.title")}
              </h1>
              <p className="mt-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
                {t("pages:dictionary.subtitle")}
              </p>
            </div>

            <button
              type="button"
              data-tauri-drag-region="false"
              onClick={() => setNewOpen(true)}
              className="shrink-0 bg-te-accent px-4 py-2 font-mono text-xs uppercase tracking-wider text-te-accent-fg transition-[filter] hover:brightness-110"
            >
              {t("pages:dictionary.new_word")}
            </button>
          </motion.div>
        </div>
      </div>

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
                    active ? "text-te-accent" : "text-te-light-gray hover:text-te-fg"
                  }`}
                >
                  <span>{t(`pages:dictionary.filters.${key}`)}</span>
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
            placeholder={t("pages:dictionary.search_placeholder")}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-[4vw] py-[clamp(1rem,2vw,2rem)]">
          {filter === "domains" ? (
            <DomainPicker
              selected={validSelected}
              onToggle={(id) => void toggleDomain(id)}
            />
          ) : (
            <DictionaryGrid
              filter={filter}
              entries={filteredEntries}
              selectedDomains={filteredDomains}
              onDeleteEntry={(id) => void removeEntry(id)}
              onRemoveDomain={(id) => void toggleDomain(id)}
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

/* ---------------- Domain Picker (domains tab) ---------------- */

interface DomainPickerProps {
  selected: DomainId[];
  onToggle: (id: DomainId) => void;
}

function DomainPicker({ selected, onToggle }: DomainPickerProps) {
  const { t } = useTranslation();
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const atLimit = selected.length >= DOMAIN_LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-te-light-gray">
        <span>{t("pages:dictionary.domains.helper")}</span>
        <span>
          {t("pages:dictionary.domains.counter", {
            count: selected.length,
            limit: DOMAIN_LIMIT,
          })}
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
              title={
                disabled
                  ? t("pages:dictionary.domains.limit_hint", { limit: DOMAIN_LIMIT })
                  : undefined
              }
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
                {t(`pages:dictionary.domains.items.${id}`)}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Mixed Grid (all / manual tabs) ---------------- */

interface DictionaryGridProps {
  filter: "all" | "manual";
  entries: DictEntry[];
  selectedDomains: DomainId[];
  onDeleteEntry: (id: string) => void;
  onRemoveDomain: (id: DomainId) => void;
}

function DictionaryGrid({
  filter,
  entries,
  selectedDomains,
  onDeleteEntry,
  onRemoveDomain,
}: DictionaryGridProps) {
  const { t } = useTranslation();
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
        {t("pages:dictionary.empty")}
      </motion.div>
    );
  }

  const showDivider = showDomains && entries.length > 0;

  return (
    <>
      {showDomains ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {selectedDomains.map((id, index) => (
            <DomainCard
              key={`domain-${id}`}
              id={id}
              index={index}
              onRemove={() => onRemoveDomain(id)}
            />
          ))}
        </div>
      ) : null}

      {showDivider ? (
        <div className="my-6 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
          <span className="h-px flex-1 bg-te-gray/40" />
          <span>{t("pages:dictionary.divider_label")}</span>
          <span className="h-px flex-1 bg-te-gray/40" />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {entries.map((entry, index) => (
          <EntryCard
            key={entry.id}
            entry={entry}
            index={index}
            onDelete={() => onDeleteEntry(entry.id)}
          />
        ))}
      </div>

      <div className="mt-10 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
        {t("pages:dictionary.count_total", {
          count: totalCount.toString().padStart(3, "0"),
        })}
      </div>
    </>
  );
}

/* ---------------- New Word Dialog ---------------- */

interface NewWordDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (term: string) => Promise<void>;
  existingTerms: string[];
}

function NewWordDialog({
  open,
  onOpenChange,
  onAdd,
  existingTerms,
}: NewWordDialogProps) {
  const { t } = useTranslation();
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setTerm("");
    setError(null);
    setSubmitting(false);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const submit = async () => {
    if (submitting) return;
    const normalized = term.trim().replace(/\s+/g, " ");
    if (!normalized) {
      setError(t("pages:dictionary.new_dialog.error_empty"));
      return;
    }
    if (existingTerms.includes(normalized.toLowerCase())) {
      setError(t("pages:dictionary.new_dialog.error_duplicate"));
      return;
    }
    setSubmitting(true);
    try {
      await onAdd(normalized);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="!gap-0 rounded-none border border-te-gray bg-te-bg p-0 sm:max-w-md">
        <DialogHeader className="border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <DialogTitle className="font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
            {t("pages:dictionary.new_dialog.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("pages:dictionary.new_dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("pages:dictionary.new_dialog.term_label")}{" "}
              <span className="text-te-accent">*</span>
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
                if (e.key === "Enter") void submit();
              }}
              placeholder={t("pages:dictionary.new_dialog.term_placeholder")}
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
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            className="border border-te-gray/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          >
            {t("actions.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="bg-te-accent px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-te-accent-fg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting
              ? t("pages:dictionary.new_dialog.submitting")
              : t("pages:dictionary.new_dialog.submit")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Cards ---------------- */

interface DomainCardProps {
  id: DomainId;
  index: number;
  onRemove: () => void;
}

function DomainCard({ id, index, onRemove }: DomainCardProps) {
  const { t } = useTranslation();
  const Icon = DOMAIN_ICONS[id];
  return (
    <motion.article
      className="group flex items-center gap-3 border border-te-accent/60 bg-te-accent/10 px-3 py-2.5 text-te-accent transition-colors hover:border-te-accent"
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.02, 0.2) }}
    >
      <span
        className="shrink-0"
        title={t("pages:dictionary.card.domain_tooltip")}
      >
        <Icon className="size-3.5" />
      </span>
      <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-bold tracking-tight">
        {t(`pages:dictionary.domains.items.${id}`)}
      </h3>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={t("pages:dictionary.card.delete")}
          title={t("pages:dictionary.card.delete")}
          onClick={onRemove}
          className="inline-flex size-6 items-center justify-center transition-colors hover:text-te-fg"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </motion.article>
  );
}

interface EntryCardProps {
  entry: DictEntry;
  index: number;
  onDelete: () => void;
}

function EntryCard({ entry, index, onDelete }: EntryCardProps) {
  const { t } = useTranslation();
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
        title={t("pages:dictionary.card.manual_tooltip")}
      >
        <Feather className="size-3.5" />
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
          aria-label={t("pages:dictionary.card.edit")}
          title={t("pages:dictionary.card.edit")}
          className="inline-flex size-6 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("pages:dictionary.card.delete")}
          title={t("pages:dictionary.card.delete")}
          onClick={onDelete}
          className="inline-flex size-6 items-center justify-center text-te-light-gray transition-colors hover:text-te-accent"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </motion.article>
  );
}
