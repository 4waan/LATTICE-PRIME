import {
  Color,
  CubeTexture,
  PMREMGenerator,
  SRGBColorSpace,
  type Texture,
  WebGLRenderer,
} from "three";

function face(hex: string, tint = "#ffffff", size = 32): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const a = new Color(hex);
  const b = new Color(tint);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, `#${a.getHexString()}`);
  g.addColorStop(1, `#${b.getHexString()}`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function makeGlassEnvironment(gl: WebGLRenderer): { texture: Texture; dispose: () => void } {
  const cube = new CubeTexture([
    face("#9ef6e8", "#5eead4"),
    face("#8259ef", "#c4b5fd"),
    face("#f7fafc", "#e8fff9"),
    face("#10141a", "#1e293b"),
    face("#dbeafe", "#e8fff9"),
    face("#ccfbf1", "#f4f7fb"),
  ]);
  cube.colorSpace = SRGBColorSpace;
  cube.needsUpdate = true;

  const pmrem = new PMREMGenerator(gl);
  const tex = pmrem.fromCubemap(cube).texture;
  cube.dispose();
  return {
    texture: tex,
    dispose: () => {
      tex.dispose();
      pmrem.dispose();
    },
  };
}
