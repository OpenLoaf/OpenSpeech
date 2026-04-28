import SectionLabel from "../components/SectionLabel";

export default function CTASection() {
  return (
    <section
      data-promo-section
      style={{ position: "relative" }}
      className="h-screen w-full bg-te-bg"
    >
      <div className="flex h-full w-full flex-col items-center justify-center gap-8 px-8 text-center">
        <SectionLabel index="04" title="DOWNLOAD" />

        <img
          src="/logo-write.png"
          alt="OpenSpeech"
          className="h-16 w-16 opacity-90"
        />

        <h2 className="font-mono text-3xl uppercase tracking-tight text-te-fg sm:text-5xl">
          OpenSpeech
        </h2>

        <p className="max-w-md text-sm leading-relaxed text-te-light-gray">
          按住快捷键说话，松开即把文字写入当前应用
        </p>

        <div className="mt-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
          <span>macOS</span>
          <span className="h-1 w-1 rounded-full bg-te-light-gray/40" />
          <span>Windows</span>
          <span className="h-1 w-1 rounded-full bg-te-light-gray/40" />
          <span>Linux</span>
        </div>

        <button
          type="button"
          className="mt-6 inline-flex items-center gap-3 bg-te-accent px-8 py-4 font-mono text-sm font-bold uppercase tracking-[0.3em] text-te-accent-fg transition hover:opacity-90"
        >
          Download
          <span>↓</span>
        </button>

        <footer className="absolute bottom-6 left-0 right-0 text-center text-[10px] uppercase tracking-[0.3em] text-te-light-gray opacity-50">
          © OpenSpeech · Open source · Cross-platform
        </footer>
      </div>
    </section>
  );
}
