import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DICT_LIMIT, useDictionaryStore } from "@/stores/dictionary";
import { useSettingsStore } from "@/stores/settings";
import {
  DOMAIN_ICONS,
  DOMAIN_IDS,
  DOMAIN_LIMIT,
  isDomainId,
  type DomainId,
} from "@/lib/domains";

export function QuickDictDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const entries = useDictionaryStore((s) => s.entries);
  const addToDb = useDictionaryStore((s) => s.add);
  const removeFromDb = useDictionaryStore((s) => s.remove);
  const selectedDomains = useSettingsStore((s) => s.aiRefine.selectedDomains);
  const setSelectedDomains = useSettingsStore((s) => s.setSelectedDomains);

  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const manualEntries = useMemo(
    () => entries.filter((e) => e.source === "manual"),
    [entries],
  );
  const existingLower = useMemo(
    () => new Set(entries.map((e) => e.term.toLowerCase())),
    [entries],
  );

  const validSelectedDomains = useMemo<DomainId[]>(
    () => selectedDomains.filter(isDomainId),
    [selectedDomains],
  );
  const selectedDomainSet = useMemo(
    () => new Set(validSelectedDomains),
    [validSelectedDomains],
  );
  const domainAtLimit = validSelectedDomains.length >= DOMAIN_LIMIT;

  const toggleDomain = (id: DomainId) => {
    const exists = selectedDomainSet.has(id);
    if (!exists && domainAtLimit) return;
    const next = exists
      ? validSelectedDomains.filter((x) => x !== id)
      : [...validSelectedDomains, id];
    void setSelectedDomains(next);
  };

  const atLimit = entries.length >= DICT_LIMIT;
  const trimmed = term.trim();

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
    const normalized = trimmed.replace(/\s+/g, " ");
    if (!normalized) {
      setError(t("pages:dictionary.new_dialog.error_empty"));
      return;
    }
    if (existingLower.has(normalized.toLowerCase())) {
      setError(t("pages:dictionary.new_dialog.error_duplicate"));
      return;
    }
    setSubmitting(true);
    try {
      await addToDb({ term: normalized });
      setTerm("");
      setError(null);
      setSubmitting(false);
      inputRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="!gap-0 max-h-[88vh] rounded-none border border-te-gray bg-te-bg p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <DialogTitle className="font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
            {t("pages:home.quick_dict.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("pages:home.quick_dict.title")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <div className="flex items-stretch gap-2">
            <input
              ref={inputRef}
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
              disabled={atLimit}
              className="flex-1 border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg placeholder:text-te-light-gray focus:border-te-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || atLimit || !trimmed}
              aria-label={t("pages:dictionary.new_dialog.submit")}
              className="inline-flex size-9 items-center justify-center bg-te-accent text-te-accent-fg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-4" aria-hidden />
            </button>
          </div>

          {error ? (
            <div className="font-mono text-[11px] uppercase tracking-wider text-[#ff4d4d]">
              {error}
            </div>
          ) : null}

          <div className="max-h-40 min-h-20 overflow-y-auto">
            {manualEntries.length === 0 ? (
              <div className="flex h-full min-h-20 items-center justify-center border border-te-gray/40 bg-te-surface px-3 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray/70">
                {t("pages:home.quick_dict.empty")}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {manualEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="group flex items-center gap-1 border border-te-gray/40 bg-te-surface px-2 py-1.5 transition-colors hover:border-te-accent"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-te-fg"
                      title={entry.term}
                    >
                      {entry.term}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeFromDb(entry.id)}
                      aria-label={t("pages:dictionary.card.delete")}
                      title={t("pages:dictionary.card.delete")}
                      className="inline-flex size-5 shrink-0 items-center justify-center text-te-light-gray opacity-0 transition-opacity hover:text-te-accent group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray">
            <span>{t("pages:home.quick_dict.domains_label")}</span>
            <span>
              {t("pages:dictionary.domains.counter", {
                count: validSelectedDomains.length,
                limit: DOMAIN_LIMIT,
              })}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {DOMAIN_IDS.map((id) => {
              const Icon = DOMAIN_ICONS[id];
              const active = selectedDomainSet.has(id);
              const disabled = !active && domainAtLimit;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleDomain(id)}
                  disabled={disabled}
                  title={
                    disabled
                      ? t("pages:dictionary.domains.limit_hint", {
                          limit: DOMAIN_LIMIT,
                        })
                      : undefined
                  }
                  className={`flex items-center gap-1.5 border px-2 py-1.5 text-left transition-colors ${
                    active
                      ? "border-te-accent bg-te-accent/10 text-te-accent"
                      : disabled
                        ? "cursor-not-allowed border-te-gray/30 bg-te-surface/40 text-te-light-gray/40"
                        : "border-te-gray/40 bg-te-surface text-te-fg hover:border-te-accent hover:text-te-accent"
                  }`}
                >
                  <Icon className="size-3 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold tracking-tight">
                    {t(`pages:dictionary.domains.items.${id}`)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
