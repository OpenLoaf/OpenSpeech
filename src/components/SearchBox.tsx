import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number;
};

export function SearchBox({
  value,
  onChange,
  placeholder = "搜索...",
  width = 224,
}: Props) {
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
    <div className="relative flex items-center" data-tauri-drag-region="false">
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
              placeholder={placeholder}
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
