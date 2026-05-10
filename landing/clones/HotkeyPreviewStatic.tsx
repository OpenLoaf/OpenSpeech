import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Kbd } from "./Kbd";

/** 静态 token 类型 —— 与 src/components/HotkeyPreview.tsx 的 HotkeyToken 子集对齐，
 *  渲染逻辑、className 1:1 复刻；剥离了平台检测 / 全局键盘监听 / Tauri 事件订阅。 */
export type StaticHotkeyToken =
  | { kind: "mod"; label: string; icon?: ReactNode | null; sideLabel?: "L" | "R" | null }
  | { kind: "main"; label: string; icon?: ReactNode | null }
  | { kind: "prefix"; label: string };

interface HotkeyPreviewStaticProps {
  /** 已按下高亮的 token 索引集合（用于 hero 录音演示阶段） */
  highlightedIndexes?: ReadonlySet<number>;
  /** 全部高亮（模拟"录音中" sessionActive 状态） */
  allHighlighted?: boolean;
  groups: Array<{ id: string; tokens: StaticHotkeyToken[] }>;
  trailing?: ReactNode;
  fillHeight?: boolean;
}

export function HotkeyPreviewStatic({
  highlightedIndexes,
  allHighlighted = false,
  groups,
  trailing,
  fillHeight = false,
}: HotkeyPreviewStaticProps) {
  const isHighlighted = (i: number) =>
    allHighlighted || (highlightedIndexes?.has(i) ?? false);

  const renderTokens = (tokens: StaticHotkeyToken[]) =>
    tokens.length === 0 ? (
      <Kbd size={fillHeight ? "lg" : "md"}>—</Kbd>
    ) : (
      tokens.map((tok, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span
              className={cn(
                "font-mono text-te-light-gray",
                fillHeight ? "text-[clamp(1rem,3cqw,2rem)]" : "text-xl",
              )}
            >
              +
            </span>
          )}
          <Kbd
            highlight={isHighlighted(i)}
            size={fillHeight ? "lg" : "md"}
          >
            {tok.kind !== "prefix" && tok.icon ? (
              <span aria-hidden className="mr-1.5 opacity-60">
                {tok.icon}
              </span>
            ) : null}
            {tok.kind === "mod" && tok.sideLabel ? (
              <span aria-hidden className="mr-1 text-[0.7em] font-bold opacity-70">
                {tok.sideLabel}
              </span>
            ) : null}
            {tok.label}
          </Kbd>
        </Fragment>
      ))
    );

  return (
    <div className={cn(fillHeight && "flex h-full min-h-0 flex-col")}>
      <div
        className={cn(
          "flex flex-col gap-3",
          "md:flex-row md:items-center md:justify-between",
          fillHeight && "min-h-0 flex-1 justify-center [container-type:inline-size]",
        )}
      >
        <div
          className={cn(
            "flex flex-wrap items-center",
            fillHeight ? "gap-[clamp(0.5rem,2cqw,1.25rem)]" : "gap-3",
          )}
        >
          {groups.map((g, gi) => (
            <Fragment key={g.id}>
              {gi > 0 && (
                <span
                  className={cn(
                    "font-mono text-te-light-gray",
                    fillHeight ? "text-[clamp(1rem,3cqw,2rem)]" : "text-xl",
                  )}
                >
                  /
                </span>
              )}
              <div
                className={cn(
                  "flex items-center",
                  fillHeight ? "gap-[clamp(0.5rem,2cqw,1.25rem)]" : "gap-3",
                )}
              >
                {renderTokens(g.tokens)}
              </div>
            </Fragment>
          ))}
        </div>

        {trailing ?? (
          <div className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
            按住说话
          </div>
        )}
      </div>
    </div>
  );
}
