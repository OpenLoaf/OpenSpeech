import SectionLabel from "../components/SectionLabel";
import { Placeholder } from "./DemoSection";

export default function ModesSection() {
  return (
    <section className="relative h-[150vh] w-full bg-te-bg">
      <div className="sticky top-0 flex h-screen w-full items-center justify-center">
        <SectionLabel index="03" title="THREE MODES" />
        <Placeholder
          title="DICTATE / ASK / TRANSLATE"
          desc="标签切换 · 不同输入流"
        />
      </div>
    </section>
  );
}
