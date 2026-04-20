"use client";

import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "glow" | "mono";
  pulse?: boolean;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "default",
  pulse = false,
  className = "",
}) => {
  const variantStyles = {
    default: "bg-blue-500/20 border border-blue-400/50 text-blue-300",
    glow: "bg-blue-500/10 border border-blue-400/40 text-blue-200 shadow-lg shadow-blue-500/20",
    mono: "bg-slate-900/50 border border-slate-700 text-slate-300 font-mono text-xs",
  };

  const pulseClass = pulse ? "animate-pulse-dot" : "";

  return (
    <div
      className={`
        inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium
        transition-all duration-300 whitespace-nowrap
        ${variantStyles[variant]} ${pulseClass} ${className}
      `}
    >
      {pulse && (
        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse-dot" />
      )}
      {children}
    </div>
  );
};
