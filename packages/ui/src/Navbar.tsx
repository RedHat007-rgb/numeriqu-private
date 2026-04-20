"use client";

import React, { useState, useEffect } from "react";
import { GlowButton } from "./GlowButton";

export const Navbar: React.FC = () => {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 w-full z-50 transition-all duration-300 ${
        isScrolled
          ? "bg-slate-900/80 backdrop-blur-xl border-b border-blue-500/20 shadow-lg shadow-blue-500/10"
          : "bg-slate-900/50 backdrop-blur-lg"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          {/* Logo Section */}
          <div className="flex items-center gap-3">
            {/* Geometric SVG Logo */}
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              className="text-blue-400"
              fill="none"
            >
              <defs>
                <linearGradient
                  id="logoGrad"
                  x1="0%"
                  y1="0%"
                  x2="100%"
                  y2="100%"
                >
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#7c3aed" />
                </linearGradient>
              </defs>
              {/* Triangular N shape */}
              <polygon
                points="16,4 26,28 6,28"
                fill="url(#logoGrad)"
                opacity="0.8"
              />
              <polygon
                points="14,10 20,22 8,22"
                fill="currentColor"
                opacity="0.3"
              />
            </svg>

            <div>
              <h1 className="text-xl font-bold font-display text-white">
                Numeriqu
              </h1>
              <p className="text-xs font-mono text-muted tracking-widest">
                ANALYTICAL PLATFORM
              </p>
            </div>
          </div>

          {/* Center Navigation */}
          <div className="hidden md:flex items-center gap-8">
            <a
              href="#platform"
              className="text-sm text-text-primary hover:text-blue-400 transition-colors"
            >
              Platform
            </a>
            <a
              href="#rag"
              className="text-sm text-text-primary hover:text-blue-400 transition-colors"
            >
              RAG Search
            </a>
            <a
              href="#features"
              className="text-sm text-text-primary hover:text-blue-400 transition-colors"
            >
              Features
            </a>
            <a
              href="#pricing"
              className="text-sm text-text-primary hover:text-blue-400 transition-colors"
            >
              Pricing
            </a>
          </div>

          {/* Right CTA Buttons */}
          <div className="flex items-center gap-4">
            <a href="/dashboard" className="text-sm text-text-primary hover:text-blue-400 transition-colors">
              Sign in
            </a>
            <GlowButton variant="primary" size="sm" href="/dashboard">
              Get Access →
            </GlowButton>
          </div>
        </div>
      </div>
    </nav>
  );
};
