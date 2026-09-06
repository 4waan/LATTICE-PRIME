import { useEffect, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";
import {
  CursorCatch,
  HiddenPathMark,
  MarketMark,
  ProofMark,
  SeamMark,
  VaultMark,
} from "./marks";
import { makeGlassEnvironment } from "./studioEnv";
import { useInView, usePageTheme, useReducedMotion } from "./hooks";

function Environment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    let alive = true;
    let env: ReturnType<typeof makeGlassEnvironment> | null = null;
    const t = window.setTimeout(() => {
      if (!alive) return;
      try {
        env = makeGlassEnvironment(gl);
        scene.environment = env.texture;
        scene.environmentIntensity = 1.05;
      } catch {
        scene.environment = null;
      }
    }, 80);
    return () => {
      alive = false;
      window.clearTimeout(t);
      scene.environment = null;
      env?.dispose();
    };
  }, [gl, scene]);
  return null;
}

function Scene() {
  const reduced = useReducedMotion();
  usePageTheme();
  const hero = useInView(".hero-frame");
  const how = useInView("#how");
  const powered = useInView("#powered");
  const hoverFine =
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover)").matches &&
    !reduced;

  return (
    <>
      <Environment />
      <hemisphereLight args={["#f7fafc", "#10141a", 0.4]} />
      <directionalLight position={[2.8, 4.8, 5.5]} intensity={1.15} color="#ffffff" />
      <directionalLight position={[-3.8, 1.2, 2.4]} intensity={0.55} color="#7ee8d8" />
      <directionalLight position={[0.6, -1.8, 4]} intensity={0.28} color="#a78bfa" />
      <CursorCatch enabled={hoverFine} />

      <SeamMark active={hero} reduced={reduced} />
      <HiddenPathMark active={how} reduced={reduced} />
      <MarketMark active={how} reduced={reduced} />
      <VaultMark active={how} reduced={reduced} />
      <ProofMark active={powered} reduced={reduced} />
    </>
  );
}

export function GlassCanvas() {
  const [play, setPlay] = useState(true);
  useEffect(() => {
    const on = () => setPlay(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  return (
    <Canvas
      frameloop={play ? "always" : "never"}
      dpr={[1, 1.5]}
      gl={{
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        powerPreference: "high-performance",
        stencil: false,
        depth: true,
      }}
      camera={{ position: [0, 0, 10], fov: 30, near: 0.1, far: 40 }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        gl.outputColorSpace = SRGBColorSpace;
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.12;
      }}
      style={{ pointerEvents: "none", width: "100%", height: "100%" }}
    >
      <Scene />
    </Canvas>
  );
}
