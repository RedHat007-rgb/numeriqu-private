"use client";

import { useRef, useEffect, useMemo } from "react";
import * as THREE from "three";

const PARTICLE_COUNT_DESKTOP = 2000;
const PARTICLE_COUNT_MOBILE = 600;

export function ParticleHero() {
  const mountRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>(0);
  const mouseRef = useRef({ x: 0, y: 0 });
  const clockRef = useRef(new THREE.Clock());

  const isMobile = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return (navigator.hardwareConcurrency ?? 4) < 4;
  }, []);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const count = isMobile ? PARTICLE_COUNT_MOBILE : PARTICLE_COUNT_DESKTOP;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    // Scene + Camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, el.clientWidth / el.clientHeight, 0.1, 1000);
    camera.position.z = 5;

    // Particles — instanced for performance
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const velocities = new Float32Array(count * 3);

    const colorOptions = [
      new THREE.Color("#2563EB"), // blue
      new THREE.Color("#3B82F6"), // blue-glow
      new THREE.Color("#F59E0B"), // gold (rare)
      new THREE.Color("#7C3AED"), // violet
      new THREE.Color("#06B6D4"), // cyan
    ];

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      positions[i3]     = (Math.random() - 0.5) * 14;
      positions[i3 + 1] = (Math.random() - 0.5) * 8;
      positions[i3 + 2] = (Math.random() - 0.5) * 6;

      velocities[i3]     = (Math.random() - 0.5) * 0.003;
      velocities[i3 + 1] = (Math.random() - 0.5) * 0.002;
      velocities[i3 + 2] = (Math.random() - 0.5) * 0.001;

      // 5% chance of gold particle
      const colorIdx = Math.random() < 0.05 ? 2 : Math.floor(Math.random() * 2);
      const c = colorOptions[colorIdx]!;
      colors[i3]     = c.r;
      colors[i3 + 1] = c.g;
      colors[i3 + 2] = c.b;

      sizes[i] = Math.random() * 2.5 + 0.5;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
      size: 0.04,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // Mouse tracking
    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current = {
        x: (e.clientX / window.innerWidth - 0.5) * 0.3,
        y: -(e.clientY / window.innerHeight - 0.5) * 0.2,
      };
    };
    window.addEventListener("mousemove", onMouseMove);

    // Resize
    const onResize = () => {
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", onResize);

    // Animate
    const posAttr = geometry.attributes["position"] as THREE.BufferAttribute;

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      const delta = clockRef.current.getDelta();
      const elapsed = clockRef.current.getElapsedTime();

      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        (posAttr.array as Float32Array)[i3]     += velocities[i3]!     + Math.sin(elapsed * 0.3 + i) * 0.0005;
        (posAttr.array as Float32Array)[i3 + 1] += velocities[i3 + 1]! + Math.cos(elapsed * 0.2 + i) * 0.0003;
        (posAttr.array as Float32Array)[i3 + 2] += velocities[i3 + 2]!;

        // Wrap particles
        if ((posAttr.array as Float32Array)[i3]     >  7) (posAttr.array as Float32Array)[i3]     = -7;
        if ((posAttr.array as Float32Array)[i3]     < -7) (posAttr.array as Float32Array)[i3]     =  7;
        if ((posAttr.array as Float32Array)[i3 + 1] >  4.5) (posAttr.array as Float32Array)[i3 + 1] = -4.5;
        if ((posAttr.array as Float32Array)[i3 + 1] < -4.5) (posAttr.array as Float32Array)[i3 + 1] =  4.5;
        if ((posAttr.array as Float32Array)[i3 + 2] >  3) (posAttr.array as Float32Array)[i3 + 2] = -3;
        if ((posAttr.array as Float32Array)[i3 + 2] < -3) (posAttr.array as Float32Array)[i3 + 2] =  3;
      }
      posAttr.needsUpdate = true;

      // Parallax
      camera.position.x += (mouseRef.current.x - camera.position.x) * 0.05;
      camera.position.y += (mouseRef.current.y - camera.position.y) * 0.05;
      camera.lookAt(scene.position);

      points.rotation.y = elapsed * 0.02;

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", onResize);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, [isMobile]);

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 -z-10"
      aria-hidden="true"
    />
  );
}
