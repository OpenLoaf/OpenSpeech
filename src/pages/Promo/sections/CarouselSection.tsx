import SectionLabel from "../components/SectionLabel";
import { Placeholder } from "./DemoSection";

export default function CarouselSection() {
  return (
    <section className="relative h-[250vh] w-full bg-te-bg">
      <div className="sticky top-0 flex h-screen w-full items-center justify-center">
        <SectionLabel index="02" title="WORKS EVERYWHERE" />
        <Placeholder
          title="VS Code · Slack · Gmail · Terminal"
          desc="四窗口横向 carousel · 悬浮条钉底"
        />
      </div>
    </section>
  );
}
