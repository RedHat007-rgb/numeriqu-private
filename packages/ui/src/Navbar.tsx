"use client";

import React, { useEffect, useState } from "react";
import { GlowButton } from "./GlowButton";

type NavbarProps = {
  /** Optional render slot for a theme toggle or any extra control on the right. */
  trailing?: React.ReactNode;
};

export const Navbar: React.FC<NavbarProps> = ({ trailing }) => {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 10);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 z-50 w-full transition-all duration-300 ${
        isScrolled
          ? "border-b border-default bg-bg-base/85 shadow-lg shadow-accent-blue/10 backdrop-blur-xl"
          : "bg-bg-base/40 backdrop-blur-md"
      }`}
      aria-label="Primary"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-20 items-center justify-between">
          <a href="/" className="flex items-center gap-3" aria-label="Numeriqu home">
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
              aria-hidden
            >
              <defs>
                <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#0077FF" />
                  <stop offset="100%" stopColor="#9B4DFF" />
                </linearGradient>
              </defs>
              {/* Q magnifying glass */}
              <circle cx="13.5" cy="13.5" r="8" stroke="url(#logoGrad)" strokeWidth="2.5" fill="none" />
              <line x1="19.5" y1="19.5" x2="26" y2="26" stroke="url(#logoGrad)" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="13.5" y1="9" x2="13.5" y2="16" stroke="url(#logoGrad)" strokeWidth="2" strokeLinecap="round" opacity="0.65" />
            </svg>

            <div>
              <h1 className="font-display text-xl font-bold text-text-primary">
                Numeriqu
              </h1>
              <p className="font-mono text-[10px] tracking-[0.28em] text-text-muted">
                FINANCIAL INTELLIGENCE
              </p>
            </div>
          </a>

          <div className="hidden items-center gap-8 md:flex">
            <a
              href="#platform"
              className="text-sm text-text-secondary transition-colors hover:text-accent-blue"
            >
              Platform
            </a>
            <a
              href="#features"
              className="text-sm text-text-secondary transition-colors hover:text-accent-blue"
            >
              Features
            </a>
            <a
              href="#pricing"
              className="text-sm text-text-secondary transition-colors hover:text-accent-blue"
            >
              Pricing
            </a>
            <a
              href="#trust"
              className="text-sm text-text-secondary transition-colors hover:text-accent-blue"
            >
              Trust
            </a>
          </div>

          <div className="flex items-center gap-3">
            {trailing}
            <a
              href="/login"
              className="text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              Sign in
            </a>
            <GlowButton variant="primary" size="sm" href="/signup">
              Start free →
            </GlowButton>
          </div>
        </div>
      </div>
    </nav>
  );
};
