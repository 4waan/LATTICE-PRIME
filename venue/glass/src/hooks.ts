import { useEffect, useRef, useState } from "react";
import { applyGlassTheme, readPageTheme, type GlassTheme } from "./glassMaterial";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function usePageTheme(): GlassTheme {
  const [theme, setTheme] = useState<GlassTheme>(() =>
    typeof document !== "undefined" ? readPageTheme() : "dark",
  );
  useEffect(() => {
    applyGlassTheme(readPageTheme());
    const mo = new MutationObserver(() => {
      const next = readPageTheme();
      setTheme(next);
      applyGlassTheme(next);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

export function useInView(selector: string, rootMargin = "60% 0px 60% 0px"): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = document.querySelector(selector);
    if (!el || !("IntersectionObserver" in window)) {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => setOn(e.isIntersecting),
      { rootMargin, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [selector, rootMargin]);
  return on;
}

export function useScrollSpin(enabled: boolean) {
  const angle = useRef(0.22);
  const vel = useRef(0);
  const lastY = useRef(typeof window !== "undefined" ? window.scrollY : 0);
  const idle = (Math.PI * 2) / 45;

  useEffect(() => {
    if (!enabled) return;
    lastY.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY.current;
      lastY.current = y;
      vel.current += dy * 0.0024;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [enabled]);

  const step = (dt: number) => {
    if (!enabled) return angle.current;
    vel.current += (0 - vel.current) * (1 - Math.exp(-dt * 1.15));
    angle.current += (idle + vel.current) * dt;
    return angle.current;
  };

  return step;
}

export function pointerPx(): { x: number; y: number } {
  const p = window.__SEAMME_POINTER;
  if (p) return p;
  return { x: window.innerWidth * 0.5, y: window.innerHeight * 0.38 };
}
