import { createBrowserRouter } from "react-router-dom";
import Layout from "@/components/Layout";
import HomePage from "@/pages/Home";
import HistoryPage from "@/pages/History";
import DictionaryPage from "@/pages/Dictionary";
import SettingsPage from "@/pages/Settings";
import OnboardingPage from "@/pages/Onboarding";
import ToolboxPage from "@/pages/Toolbox";
import MeetingsPage from "@/pages/Meetings";

export const router = createBrowserRouter([
  // Onboarding 是独立全屏页面（不进 Layout 的 sidebar 壳），完成后再 navigate("/")
  { path: "/onboarding", Component: OnboardingPage },
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: HomePage },
      { path: "toolbox", Component: ToolboxPage },
      { path: "meetings", Component: MeetingsPage },
      { path: "history", Component: HistoryPage },
      { path: "dictionary", Component: DictionaryPage },
      { path: "settings", Component: SettingsPage },
    ],
  },
]);
