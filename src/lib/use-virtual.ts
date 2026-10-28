"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/** Fixed-row-height windowing: renders only the rows intersecting the viewport (plus overscan). */
export function useVirtualRows(ref: RefObject<HTMLElement | null>, count: number, rowHeight: number, overscan = 12) {
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);

  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan);

  const scrollToIndex = useCallback(
    (index: number, align: "center" | "nearest" = "center") => {
      const el = ref.current;
      if (!el) return;
      const top = index * rowHeight;
      if (align === "nearest" && top >= el.scrollTop && top + rowHeight <= el.scrollTop + el.clientHeight) return;
      el.scrollTo({ top: Math.max(0, top - (align === "center" ? el.clientHeight / 2 - rowHeight : 0)) });
    },
    [ref, rowHeight]
  );

  return { start, end, totalHeight: count * rowHeight, offset: start * rowHeight, scrollToIndex };
}
