import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { type BufferGeometry, Group } from "three";
import { disposeGlass, glassMaterial } from "./glassMaterial";

type GlassMeshProps = {
  geometry: BufferGeometry;
  thickness?: number;
  opacity?: number;
};

export function GlassMesh({ geometry, thickness = 0.55, opacity }: GlassMeshProps) {
  const mat = useMemo(() => {
    const m = glassMaterial({ thickness });
    if (opacity != null) {
      m.opacity = opacity;
      m.userData.lockedOpacity = opacity;
    }
    return m;
  }, [thickness, opacity]);

  useLayoutEffect(
    () => () => {
      disposeGlass(mat);
    },
    [mat],
  );

  return <mesh geometry={geometry} material={mat} />;
}

type AnchoredProps = {
  anchorId: string;
  pixelSize: number;
  native: number;
  active: boolean;
  children: ReactNode;
};

export function Anchored({ anchorId, pixelSize, native, active, children }: AnchoredProps) {
  const ref = useRef<Group>(null);
  const { camera, size } = useThree();

  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const el = document.getElementById(anchorId);
    if (!el || getComputedStyle(el).display === "none" || !active) {
      g.visible = false;
      return;
    }
    g.visible = true;
    const r = el.getBoundingClientRect();
    const ndcX = ((r.left + r.width / 2) / size.width) * 2 - 1;
    const ndcY = -((r.top + r.height / 2) / size.height) * 2 + 1;
    const dist = camera.position.z;
    const fov = "fov" in camera ? (camera.fov as number) : 30;
    const worldH = 2 * Math.tan((fov * Math.PI) / 360) * dist;
    const worldW = worldH * (size.width / size.height);
    g.position.set(ndcX * worldW * 0.5, ndcY * worldH * 0.5, 0);
    const box = Math.min(r.width, r.height);
    const px = box > 16 ? box : pixelSizeFor(pixelSize, size.width);
    g.scale.setScalar((px / size.height) * worldH / native);
  });

  return <group ref={ref}>{children}</group>;
}

function pixelSizeFor(base: number, width: number): number {
  if (width < 700) return base * 0.58;
  if (width < 960) return base * 0.78;
  return base;
}