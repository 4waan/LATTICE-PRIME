/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    SeamGlass?: {
      mount: (el: HTMLElement | null) => void;
      unmount: () => void;
    };
    __SEAMME_POINTER?: { x: number; y: number };
  }
}
