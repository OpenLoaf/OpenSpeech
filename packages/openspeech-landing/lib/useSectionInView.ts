import { useEffect, useRef, useState } from "react";

/** 监听元素是否进入视口 amount=0.4 表示露出 40% 才算 active；sticky=true 一旦 active 不再回 false（避免回滚反向动画跳动） */
export function useSectionInView<T extends HTMLElement>(
  amount = 0.4,
  options?: { sticky?: boolean },
) {
  const sticky = options?.sticky ?? false;
  const ref = useRef<T | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= amount) {
            setActive(true);
          } else if (!sticky && e.intersectionRatio < amount * 0.4) {
            setActive(false);
          }
        }
      },
      { threshold: [0, amount * 0.4, amount, 0.7, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [amount, sticky]);

  return { ref, active };
}
