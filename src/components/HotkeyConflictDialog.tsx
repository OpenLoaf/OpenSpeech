import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HotkeyBinder } from "@/components/HotkeyBinder";
import { useUIStore } from "@/stores/ui";
import { BINDING_IDS, BINDING_LABELS, type BindingId } from "@/lib/hotkey";

const KNOWN: ReadonlySet<string> = new Set(BINDING_IDS);

export function HotkeyConflictDialog() {
  const { t } = useTranslation();
  const conflicts = useUIStore((s) => s.hotkeyConflicts);
  const clearHotkeyConflicts = useUIStore((s) => s.clearHotkeyConflicts);

  const knownConflicts = useMemo(
    () => conflicts.filter((c): c is { id: BindingId; error: string } => KNOWN.has(c.id)),
    [conflicts],
  );
  const ids = useMemo<BindingId[]>(
    () => knownConflicts.map((c) => c.id),
    [knownConflicts],
  );

  const open = ids.length > 0;

  const handleOpenChange = (next: boolean) => {
    if (!next) clearHotkeyConflicts();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-md"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <AlertTriangle className="size-4 shrink-0 text-te-accent" aria-hidden />
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("dialogs:hotkey_conflict.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialogs:hotkey_conflict.description", { count: ids.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pt-4 pb-2 font-sans text-sm leading-relaxed text-te-light-gray">
          {t("dialogs:hotkey_conflict.description", { count: ids.length })}
        </div>

        {knownConflicts.some((c) => c.error) ? (
          <ul className="mx-5 mb-2 flex flex-col gap-1 border-l-2 border-te-accent/40 pl-3 font-mono text-[11px] text-te-light-gray">
            {knownConflicts
              .filter((c) => c.error)
              .map((c) => (
                <li key={c.id}>
                  <span className="text-te-fg">{BINDING_LABELS[c.id]}</span>
                  <span className="text-te-light-gray/70"> — {c.error}</span>
                </li>
              ))}
          </ul>
        ) : null}

        <div className="px-5 pt-1 pb-4">
          <HotkeyBinder filterIds={ids} divided />
        </div>
      </DialogContent>
    </Dialog>
  );
}
