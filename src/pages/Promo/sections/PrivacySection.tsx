import SectionLabel from "../components/SectionLabel";
import { Placeholder } from "./DemoSection";

export default function PrivacySection() {
  return (
    <section className="relative h-[200vh] w-full bg-te-bg">
      <div className="sticky top-0 flex h-screen w-full items-center justify-center">
        <SectionLabel index="05" title="PRIVATE BY DEFAULT" />
        <Placeholder
          title="No upload · No store · Bring your own model"
          desc="三行 mono · 工业风图标 · BYO 配置框"
        />
      </div>
    </section>
  );
}
