import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, Group, MathUtils, MeshBasicMaterial, PointLight } from "three";
import {
  hiddenPathPoint,
  makeCuboid,
  makeHiddenPathDisc,
  makeHiddenPathSeam,
  makeMarketBar,
  makeProofDisc,
  makeSeamRibbon,
  SEAM_NATIVE_HEIGHT,
} from "./geometry";
import { Anchored, GlassMesh } from "./objects";
import { pointerPx, useScrollSpin } from "./hooks";

type MarkProps = {
  active: boolean;
  reduced: boolean;
};

export function SeamMark({ active, reduced }: MarkProps) {
  const geo = useMemo(() => makeSeamRibbon(), []);
  const inner = useRef<Group>(null);
  const step = useScrollSpin(!reduced);

  useFrame((_, dt) => {
    if (!inner.current || !active) return;
    inner.current.rotation.y = reduced ? 0.18 : step(dt);
  });

  return (
    <Anchored anchorId="ga-seam" pixelSize={440} native={SEAM_NATIVE_HEIGHT} active={active}>
      <group ref={inner} rotation={[0.08, 0.18, 0]}>
        <GlassMesh geometry={geo} thickness={1.3} />
      </group>
    </Anchored>
  );
}

export function VaultMark({ active, reduced }: MarkProps) {
  const geo = useMemo(() => makeCuboid(), []);
  const group = useRef<Group>(null);
  const a = useRef<Group>(null);
  const b = useRef<Group>(null);

  useFrame(({ clock }) => {
    if (!group.current || !a.current || !b.current || !active) return;
    if (reduced) {
      group.current.position.y = 0;
      a.current.position.y = 0.22;
      b.current.position.y = -0.22;
      return;
    }
    const t = clock.elapsedTime;
    group.current.position.y = Math.sin(t * 0.55) * 0.07;
    const gap = 0.20 + 0.11 * (0.5 + 0.5 * Math.sin(t * 0.7));
    a.current.position.y = gap;
    b.current.position.y = -gap;
  });

  return (
    <Anchored anchorId="ga-vault" pixelSize={86} native={1.4} active={active}>
      <group ref={group} rotation={[0.18, 0.55, 0.08]}>
        <group ref={a}>
          <GlassMesh geometry={geo} thickness={0.7} />
        </group>
        <group ref={b}>
          <GlassMesh geometry={geo} thickness={0.7} />
        </group>
      </group>
    </Anchored>
  );
}

export function HiddenPathMark({ active, reduced }: MarkProps) {
  const disc = useMemo(() => makeHiddenPathDisc(), []);
  const seam = useMemo(() => makeHiddenPathSeam(), []);
  const light = useRef<Group>(null);
  const glow = useRef<PointLight>(null);
  const core = useRef<MeshBasicMaterial>(null);
  const seamMat = useRef<MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    if (!active) return;
    const cycle = 9.5;
    if (reduced) {
      if (light.current) light.current.visible = false;
      if (seamMat.current) seamMat.current.opacity = 0.18;
      return;
    }
    const u = clock.elapsedTime % cycle;
    let travel = 0;
    let appear = 0;
    if (u < 1.1) appear = 0;
    else if (u < 1.9) {
      appear = (u - 1.1) / 0.8;
      travel = 0;
    } else if (u < 6.6) {
      appear = 1;
      travel = (u - 1.9) / 4.7;
    } else if (u < 8.0) {
      appear = 1 - (u - 6.6) / 1.4;
      travel = 1;
    } else {
      appear = 0;
      travel = 1;
    }
    const p = hiddenPathPoint(MathUtils.clamp(travel, 0, 1));
    if (light.current) {
      light.current.visible = appear > 0.03;
      light.current.position.set(p.x, p.y, 0.05);
    }
    if (glow.current) glow.current.intensity = appear * 1.1;
    if (core.current) core.current.opacity = 0.55 * appear;
    if (seamMat.current) seamMat.current.opacity = 0.12 + 0.45 * appear;
  });

  return (
    <Anchored anchorId="ga-path" pixelSize={78} native={2.05} active={active}>
      <group rotation={[0.1, -0.12, 0]}>
        <GlassMesh geometry={disc} thickness={0.45} />
        <mesh geometry={seam}>
          <meshBasicMaterial
            ref={seamMat}
            color="#9ef6e8"
            transparent
            opacity={0.2}
            depthWrite={false}
            blending={AdditiveBlending}
          />
        </mesh>
        <group ref={light} visible={false}>
          <pointLight ref={glow} color="#9ef6e8" intensity={0} distance={1.4} decay={2} />
          <mesh>
            <sphereGeometry args={[0.05, 12, 12]} />
            <meshBasicMaterial
              ref={core}
              color="#e8fffb"
              transparent
              opacity={0}
              depthWrite={false}
              blending={AdditiveBlending}
            />
          </mesh>
        </group>
      </group>
    </Anchored>
  );
}

export function MarketMark({ active, reduced }: MarkProps) {
  const geo = useMemo(() => makeMarketBar(), []);
  const bars = useRef<Group>(null);

  useFrame(({ clock }) => {
    if (!bars.current || !active) return;
    const t = clock.elapsedTime;
    const left = reduced ? 0.72 : 0.68 + 0.10 * Math.sin(t * 1.05);
    const right = reduced ? 0.72 : 0.68 + 0.10 * Math.sin(t * 0.88 + 2.1);
    let center = reduced ? 1.08 : 0.98 + 0.10 * Math.sin(t * 0.72 + 0.6);
    center = Math.max(center, left, right) + 0.16;
    const xs = [-0.40, 0, 0.40];
    const ys = [left, center, right];
    bars.current.children.forEach((c, i) => {
      c.position.set(xs[i], -ys[i] * 0.5, 0);
      c.scale.set(1, ys[i], 1);
    });
  });

  return (
    <Anchored anchorId="ga-market" pixelSize={78} native={1.35} active={active}>
      <group ref={bars} rotation={[0.06, 0.1, 0]}>
        {[0, 1, 2].map((i) => (
          <group key={i}>
            <GlassMesh geometry={geo} thickness={0.55} />
          </group>
        ))}
      </group>
    </Anchored>
  );
}

export function ProofMark({ active, reduced }: MarkProps) {
  const geo = useMemo(() => makeProofDisc(), []);
  const spin = useRef<Group>(null);

  useFrame(({ clock }) => {
    if (!spin.current || !active) return;
    spin.current.rotation.y = reduced ? 0.2 : (clock.elapsedTime * Math.PI * 2) / 24;
  });

  return (
    <Anchored anchorId="ga-proof" pixelSize={72} native={2.05} active={active}>
      <group ref={spin} rotation={[0.18, 0.2, 0]}>
        <GlassMesh geometry={geo} thickness={0.8} />
      </group>
    </Anchored>
  );
}

export function CursorCatch({ enabled }: { enabled: boolean }) {
  const ref = useRef<PointLight>(null);

  useFrame(({ camera, size }) => {
    const light = ref.current;
    if (!light) return;
    if (!enabled) {
      light.intensity = 0;
      return;
    }
    const p = pointerPx();
    const ndcX = (p.x / size.width) * 2 - 1;
    const ndcY = -(p.y / size.height) * 2 + 1;
    const fov = "fov" in camera ? (camera.fov as number) : 30;
    const worldH = 2 * Math.tan((fov * Math.PI) / 360) * camera.position.z;
    const worldW = worldH * (size.width / size.height);
    light.position.set(ndcX * worldW * 0.5, ndcY * worldH * 0.5, 3.2);
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    light.color.set(dark ? "#a78bfa" : "#6366f1");
    light.intensity = dark ? 2.2 : 1.1;
  });

  return <pointLight ref={ref} color="#a78bfa" intensity={0} distance={6.5} decay={1.8} />;
}
