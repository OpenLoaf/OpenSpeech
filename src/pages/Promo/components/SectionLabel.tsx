type Props = {
  index: string;
  title: string;
  className?: string;
};

export default function SectionLabel({ index, title, className }: Props) {
  return (
    <div
      className={
        "absolute left-8 top-8 z-20 flex items-center gap-3 text-[10px] uppercase tracking-[0.3em] text-te-light-gray " +
        (className ?? "")
      }
    >
      <span className="text-te-accent">{index}</span>
      <span className="h-px w-8 bg-te-light-gray/40" />
      <span>{title}</span>
    </div>
  );
}
