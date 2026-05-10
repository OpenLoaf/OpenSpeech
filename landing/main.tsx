import React from "react";
import ReactDOM from "react-dom/client";
import Lenis from "lenis";
import LandingPage from "./LandingPage";
import "lenis/dist/lenis.css";
import "./styles.css";

document.documentElement.classList.add("dark");
document.documentElement.style.userSelect = "none";
document.documentElement.style.setProperty("-webkit-user-select", "none");

const lenis = new Lenis({
  duration: 1.4,
  easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  smoothWheel: true,
  wheelMultiplier: 1.0,
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
  lenis.scrollTo(el, { offset: 0, duration: 1.6 });
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LandingPage />
  </React.StrictMode>,
);
