"use client";

import { motion, useReducedMotion } from "framer-motion";

export function HeroBackdrop() {
  const reducedMotion = useReducedMotion();

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        className="absolute -left-24 top-14 h-72 w-72 rounded-full bg-accent-blue/12 blur-3xl"
        animate={
          reducedMotion
            ? undefined
            : { x: [0, 30, -20, 0], y: [0, -18, 12, 0] }
        }
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute right-[-120px] top-[-20px] h-96 w-96 rounded-full bg-accent-cyan/10 blur-3xl"
        animate={
          reducedMotion
            ? undefined
            : { x: [0, -35, 20, 0], y: [0, 16, -12, 0] }
        }
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-[-160px] left-1/3 h-80 w-80 rounded-full bg-accent-violet/10 blur-3xl"
        animate={reducedMotion ? undefined : { y: [0, -24, 0], x: [0, 16, 0] }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_45%)] dark:block hidden" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(6,12,30,0.66)_0%,rgba(6,12,30,0.82)_62%,rgba(6,12,30,1)_100%)] dark:block hidden" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.9)_0%,rgba(249,251,255,1)_65%,rgba(244,247,253,1)_100%)] block dark:hidden" />
    </div>
  );
}
