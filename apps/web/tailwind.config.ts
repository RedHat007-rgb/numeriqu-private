import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        void:    "#050508",
        ink:     "#0A0A12",
        surface: "#0F0F1A",
        panel:   "#13131F",
        accent: {
          DEFAULT: "#2563EB",
          glow:    "#3B82F6",
          gold:    "#F59E0B",
          emerald: "#10B981",
          rose:    "#F43F5E",
          violet:  "#7C3AED",
          cyan:    "#06B6D4",
        },
        text: {
          primary:   "#F8FAFC",
          secondary: "#94A3B8",
          muted:     "#475569",
        },
      },
      fontFamily: {
        sans:    ["var(--font-dm-sans)",           "system-ui", "sans-serif"],
        serif:   ["var(--font-instrument-serif)",  "Georgia",   "serif"],
        mono:    ["var(--font-jetbrains-mono)",    "Menlo",     "monospace"],
        display: ["var(--font-dm-sans)",           "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "gradient-hero":   "radial-gradient(ellipse at 20% 50%, rgba(37,99,235,0.15) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(245,158,11,0.08) 0%, transparent 50%)",
        "gradient-card":   "linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)",
        "gradient-glow":   "radial-gradient(circle at center, rgba(37,99,235,0.4) 0%, transparent 70%)",
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "dot-grid":        "radial-gradient(circle, rgba(37,99,235,0.15) 1px, transparent 1px)",
        "mesh":            "radial-gradient(at 40% 20%, rgba(37,99,235,0.12) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(124,58,237,0.08) 0px, transparent 50%), radial-gradient(at 0% 50%, rgba(16,185,129,0.06) 0px, transparent 50%)",
      },
      backgroundSize: {
        "dot-grid": "32px 32px",
      },
      boxShadow: {
        "glow-blue":    "0 0 24px rgba(37,99,235,0.5), 0 0 48px rgba(37,99,235,0.2)",
        "glow-gold":    "0 0 24px rgba(245,158,11,0.4)",
        "glow-emerald": "0 0 24px rgba(16,185,129,0.4)",
        "glass":        "0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)",
        "glass-heavy":  "0 8px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08)",
        "card-hover":   "0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(37,99,235,0.2)",
        "glow-violet":  "0 0 24px rgba(124,58,237,0.3)",
      },
      backdropBlur: {
        xs:  "4px",
        sm:  "8px",
        md:  "12px",
        lg:  "20px",
        xl:  "40px",
        "2xl": "60px",
      },
      animation: {
        "float":      "float 6s ease-in-out infinite",
        "glow-pulse": "glow-pulse 3s ease-in-out infinite",
        "slide-up":   "slide-up 0.6s cubic-bezier(0.16,1,0.3,1) forwards",
        "fade-in":    "fade-in 0.4s ease forwards",
        "shimmer":    "shimmer 2s linear infinite",
        "marquee":    "marquee 30s linear infinite",
        "breathe":    "breathe 4s ease-in-out infinite",
        "spin-slow":  "spin 8s linear infinite",
        "pulse-subtle": "pulse-subtle 3s cubic-bezier(0.4,0,0.6,1) infinite",
      },
      keyframes: {
        float: {
          "0%,100%": { transform: "translateY(0px)" },
          "50%":     { transform: "translateY(-16px)" },
        },
        "glow-pulse": {
          "0%,100%": { opacity: "0.6", transform: "scale(1)" },
          "50%":     { opacity: "1",   transform: "scale(1.05)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(32px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        marquee: {
          "0%":   { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        breathe: {
          "0%,100%": { transform: "scale(1)",    opacity: "0.7" },
          "50%":     { transform: "scale(1.03)", opacity: "1" },
        },
        "pulse-subtle": {
          "0%,100%": { opacity: "1" },
          "50%":     { opacity: "0.5" },
        },
      },
      transitionTimingFunction: {
        "spring": "cubic-bezier(0.16, 1, 0.3, 1)",
        "bounce": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      blur: {
        "3xl": "48px",
        "4xl": "80px",
      },
    },
  },
  plugins: [typography],
};

export default config;
