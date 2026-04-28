import React from "react";
import ReactDOM from "react-dom/client";
import PromoPage from "@/pages/Promo";
import "./App.css";

document.documentElement.classList.add("dark");
// 主 App 的 App.css 把 html/body/#root 设成 overflow:hidden + height:100%（桌面壳风格）。
// Promo 是公网网页必须滚动；CSS 层级很容易被覆盖，这里用 inline style 强行解锁三层，绕过任何 cascade。
const unlock = (el: HTMLElement) => {
  el.style.overflow = "visible";
  el.style.height = "auto";
  el.style.overscrollBehavior = "auto";
};
unlock(document.documentElement);
unlock(document.body);
const rootEl = document.getElementById("root");
if (rootEl) unlock(rootEl);
document.documentElement.classList.add("promo-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PromoPage />
  </React.StrictMode>,
);
