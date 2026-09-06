import { createRoot, type Root } from "react-dom/client";
import { GlassCanvas } from "./GlassCanvas";
import { applyGlassTheme, readPageTheme } from "./glassMaterial";

let root: Root | null = null;

function webglOk(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function mount(el: HTMLElement | null): void {
  if (!el || root) return;
  if (!webglOk()) return;
  applyGlassTheme(readPageTheme());
  document.documentElement.classList.add("has-glass");
  root = createRoot(el);
  root.render(<GlassCanvas />);
}

export function unmount(): void {
  root?.unmount();
  root = null;
  document.documentElement.classList.remove("has-glass");
}
