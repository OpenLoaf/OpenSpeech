import React from "react";
import ReactDOM from "react-dom/client";
import PromoPage from "@/pages/Promo";
import "./App.css";

document.documentElement.classList.add("dark");
// 主 App 的 App.css 把 html/body/#root 设成 overflow:hidden（桌面壳风格）；
// Promo 是公网网页，需要常规浏览器滚动。挂一个 class 让 CSS 解锁三层 overflow。
document.documentElement.classList.add("promo-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PromoPage />
  </React.StrictMode>,
);
