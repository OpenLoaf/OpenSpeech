import React from "react";
import ReactDOM from "react-dom/client";
import Lenis from "lenis";
import PromoPage from "@/pages/Promo";
import "./App.css";
import "lenis/dist/lenis.css";

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
document.documentElement.style.userSelect = "none";
document.documentElement.style.setProperty("-webkit-user-select", "none");

const lenis = new Lenis({
  duration: 1.6,
  easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  smoothWheel: true,
});

const raf = (time: number) => {
  lenis.raf(time);
  requestAnimationFrame(raf);
};
requestAnimationFrame(raf);

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  const link = target?.closest("a[href^='#']") as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute("href");
  if (!href || href === "#") return;
  const id = href.slice(1);
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  lenis.scrollTo(el, { offset: -72, duration: 2.2 });
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PromoPage />
  </React.StrictMode>,
);
