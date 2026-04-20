"use client";

import React from "react";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  glowColor?: "blue" | "violet" | "none";
}

export const GlassCard: React.FC<GlassCardProps> = ({
  children,
  className = "",
  glowColor = "none",
}) => {
  const glowClasses = {
    blue: "glow-blue",
    violet: "glow-violet",
    none: "",
  };

  return (
    <div className={`glass-card ${glowClasses[glowColor]} ${className}`}>
      {children}
    </div>
  );
};
