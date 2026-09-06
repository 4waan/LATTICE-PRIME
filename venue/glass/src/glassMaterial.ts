import {
  Color,
  MeshPhysicalMaterial,
  type MeshPhysicalMaterialParameters,
} from "three";

const live = new Set<MeshPhysicalMaterial>();

export type GlassTheme = "light" | "dark";

const TINT = {
  light: {
    color: "#dff8f1",
    attenuation: "#2f9f90",
    specular: "#c4b5fd",
    opacity: 0.82,
    env: 0.85,
  },
  dark: {
    color: "#e5fbf5",
    attenuation: "#7ee8d8",
    specular: "#d4c4ff",
    opacity: 1,
    env: 1.45,
  },
};

let theme: GlassTheme = "dark";

export function glassMaterial(extra: MeshPhysicalMaterialParameters = {}): MeshPhysicalMaterial {
  const t = TINT[theme];
  const m = new MeshPhysicalMaterial({
    color: new Color(t.color),
    metalness: 0,
    roughness: 0.3,
    transmission: 0.78,
    thickness: 1.15,
    ior: 1.5,
    attenuationColor: new Color(t.attenuation),
    attenuationDistance: 0.7,
    clearcoat: 0.42,
    clearcoatRoughness: 0.38,
    transparent: true,
    opacity: t.opacity,
    depthWrite: true,
    envMapIntensity: t.env,
    specularIntensity: 0.45,
    specularColor: new Color(t.specular),
    ...extra,
  });
  (m as MeshPhysicalMaterial & { dispersion?: number }).dispersion = 0.04;
  live.add(m);
  return m;
}

export function applyGlassTheme(next: GlassTheme): void {
  theme = next;
  const t = TINT[next];
  for (const m of live) {
    if (m.userData.lockedOpacity == null) m.opacity = t.opacity;
    m.color.set(t.color);
    m.attenuationColor.set(t.attenuation);
    m.envMapIntensity = t.env;
    m.needsUpdate = true;
  }
}

export function disposeGlass(m: MeshPhysicalMaterial): void {
  live.delete(m);
  m.dispose();
}

export function readPageTheme(): GlassTheme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}
