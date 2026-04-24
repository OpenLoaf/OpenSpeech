import { createBrowserRouter } from "react-router-dom";
import Layout from "@/components/Layout";
import HomePage from "@/pages/Home";
import HistoryPage from "@/pages/History";
import DictionaryPage from "@/pages/Dictionary";
import SettingsPage from "@/pages/Settings";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: HomePage },
      { path: "history", Component: HistoryPage },
      { path: "dictionary", Component: DictionaryPage },
      { path: "settings", Component: SettingsPage },
    ],
  },
]);
