import SectionLabel from "../components/SectionLabel";

export default function DemoSection() {
  return (
    <section className="relative h-[200vh] w-full bg-te-bg">
      <div className="sticky top-0 flex h-screen w-full items-center justify-center">
        <SectionLabel index="01" title="CORE DEMO" />
        <Placeholder
          title="按住 → 说话 → 松开"
          desc="键盘高亮 · 悬浮条滑入 · 波形跳 · 转写 · 文字流入"
        />
      </div>
    </section>
  );
}

export function Placeholder({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="font-mono text-3xl uppercase tracking-tight text-te-fg sm:text-5xl">
        {title}
      </div>
      <div className="text-xs uppercase tracking-[0.3em] text-te-light-gray">
        {desc}
      </div>
      <div className="mt-6 inline-flex items-center gap-2 border border-dashed border-te-gray px-4 py-2 text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
        <span className="h-1.5 w-1.5 rounded-full bg-te-accent" />
        scaffold · animation pending
      </div>
    </div>
  );
}
