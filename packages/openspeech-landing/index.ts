// Main landing page
export { default as LandingPage } from './LandingPage';

// Sections
export { default as HeroSection } from './sections/HeroSection';
export { default as WhyNotImeSection } from './sections/WhyNotImeSection';
export { default as AccuracySection } from './sections/AccuracySection';
export { default as DictionarySection } from './sections/DictionarySection';
export { default as CTASection } from './sections/CTASection';
export { default as MeetingSection } from './sections/MeetingSection';

// Components
export { default as TopNav } from './components/TopNav';
export { default as SectionIndicator } from './components/SectionIndicator';
export { default as AppWindow } from './components/AppWindow';

// Clones (static versions for landing)
export { HotkeyPreviewStatic, type StaticHotkeyToken } from './clones/HotkeyPreviewStatic';
export { DictionaryStatic } from './clones/DictionaryStatic';
export { HeroDemo, useStageCycle, type Stage } from './clones/PromoDemoStatic';
export { MeetingsLiveStatic } from './clones/MeetingsLiveStatic';
export { Kbd } from './clones/Kbd';
export { PulsarGrid } from './clones/PulsarGrid';
export { HotkeyDictationCardStatic } from './clones/HotkeyDictationCardStatic';

// Utilities
export * from './lib/cn';
export * from './lib/useSectionInView';
