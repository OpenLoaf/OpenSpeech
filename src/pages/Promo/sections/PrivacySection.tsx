import { useRef } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "framer-motion";
import SectionLabel from "../components/SectionLabel";

const PRINCIPLES: { tag: string; text: string; sub: string }[] = [
  {
    tag: "01",
    text: "No audio uploaded for audit",
    sub: "录音帧只在你和模型之间流动，OpenSpeech 不留存",
  },
  {
    tag: "02",
    text: "Recordings stay on device",
    sub: "本地 WAV 落盘，可随时删除；内存帧 zeroize",
  },
  {
    tag: "03",
    text: "Bring your own model",
    sub: "填一个 REST endpoint，账单全部由你掌控",
  },
];

export default function PrivacySection() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });

  return (
    <section
      ref={ref}
      data-promo-section
      style={{ position: "relative" }}
      className="h-[150vh] w-full bg-te-bg"
    >
      <div className="sticky top-0 flex h-screen w-full items-center justify-center overflow-hidden">
        <SectionLabel index="03" title="PRIVATE BY DEFAULT" />

        <div className="grid w-full max-w-5xl grid-cols-1 items-center gap-10 px-8 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
          <div className="flex flex-col gap-6">
            <motion.h2
              className="font-mono text-4xl font-bold uppercase leading-[1.05] tracking-tight text-te-fg sm:text-5xl md:text-6xl"
              style={{
                opacity: useTransform(scrollYProgress, [0, 0.15], [0.3, 1]),
              }}
            >
              Private by default.<br />
              <span className="text-te-accent">Yours by design.</span>
            </motion.h2>

            <ul className="flex flex-col gap-4">
              {PRINCIPLES.map((p, i) => (
                <PrincipleRow key={p.tag} item={p} index={i} progress={scrollYProgress} />
              ))}
            </ul>
          </div>

          <ByoEndpointMock progress={scrollYProgress} />
        </div>
      </div>
    </section>
  );
}

function PrincipleRow({
  item,
  index,
  progress,
}: {
  item: { tag: string; text: string; sub: string };
  index: number;
  progress: MotionValue<number>;
}) {
  // 三行依次揭示：每行占 progress 的一段
  const start = 0.15 + index * 0.18;
  const end = start + 0.15;
  const opacity = useTransform(progress, [start, end], [0, 1]);
  const x = useTransform(progress, [start, end], [-20, 0]);

  return (
    <motion.li
      className="flex items-start gap-4 border-l-2 border-te-accent pl-4"
      style={{ opacity, x }}
    >
      <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
        {`> ${item.tag}`}
      </span>
      <div className="flex flex-col gap-1">
        <span className="font-mono text-base font-bold uppercase tracking-tight text-te-fg">
          {item.text}
        </span>
        <span className="text-xs leading-relaxed text-te-light-gray">
          {item.sub}
        </span>
      </div>
    </motion.li>
  );
}

function ByoEndpointMock({ progress }: { progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [0.5, 0.75], [0, 1]);
  const y = useTransform(progress, [0.5, 0.75], [40, 0]);

  return (
    <motion.div
      data-promo-hide-mobile
      className="flex flex-col gap-3 self-center border border-te-gray bg-te-surface p-5 font-mono text-xs"
      style={{ opacity, y }}
    >
      <div className="flex items-center justify-between border-b border-te-gray/60 pb-2 text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
        <span>settings · model</span>
        <span className="text-te-accent">BYO</span>
      </div>

      <Field label="endpoint">
        <span className="text-te-fg">https://api.your-stt.com/v1/asr</span>
      </Field>
      <Field label="api_key">
        <span className="text-te-light-gray">sk-•••••••••••••••••</span>
      </Field>
      <Field label="model">
        <span className="text-te-fg">whisper-large-v3</span>
      </Field>
      <Field label="lang">
        <span className="text-te-fg">zh</span>
      </Field>

      <div className="mt-2 flex items-center justify-between border-t border-te-gray/60 pt-3 text-[10px] uppercase tracking-[0.3em]">
        <span className="text-te-light-gray">no saas · no quota</span>
        <span className="flex items-center gap-2 text-te-accent">
          <span className="h-1.5 w-1.5 rounded-full bg-te-accent" />
          ready
        </span>
      </div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-baseline gap-3">
      <span className="text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
        {label}
      </span>
      <span>{children}</span>
    </div>
  );
}
