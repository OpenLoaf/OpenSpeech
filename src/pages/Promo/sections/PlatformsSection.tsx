import SectionLabel from "../components/SectionLabel";
import { Placeholder } from "./DemoSection";

export default function PlatformsSection() {
  return (
    <section className="relative h-[150vh] w-full bg-te-bg">
      <div className="sticky top-0 flex h-screen w-full items-center justify-center">
        <SectionLabel index="04" title="SHIPPED IN SYNC" />
        <Placeholder
          title="macOS · Windows · Linux"
          desc="三栏依次亮起 · 同步弹悬浮条"
        />
      </div>
    </section>
  );
}
