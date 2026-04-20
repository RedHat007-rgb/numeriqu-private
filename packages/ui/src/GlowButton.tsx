"use client";

import React from "react";

interface GlowButtonProps {
  variant?: "primary" | "ghost";
  size?: "sm" | "md" | "lg";
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
}

export const GlowButton: React.FC<GlowButtonProps> = ({
  variant = "primary",
  size = "md",
  children,
  icon,
  className = "",
  onClick,
  href,
  disabled = false,
}) => {
  const baseStyles = `
    inline-flex items-center justify-center gap-2 font-medium transition-all duration-300 
    rounded-full disabled:opacity-50 disabled:cursor-not-allowed
  `;

  const variantStyles = {
    primary: `
      bg-gradient-to-r from-blue-500 to-violet-600 text-white 
      shadow-lg shadow-blue-500/50 hover:shadow-xl hover:shadow-blue-500/70 
      hover:scale-105 hover:from-blue-600 hover:to-violet-700
      focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-slate-900
    `,
    ghost: `
      bg-transparent border border-white/20 text-white 
      hover:border-blue-500 hover:text-blue-300 hover:shadow-lg hover:shadow-blue-500/20
      focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-slate-900
    `,
  };

  const sizeStyles = {
    sm: "px-4 py-2 text-sm",
    md: "px-6 py-3 text-base",
    lg: "px-8 py-4 text-lg",
  };

  const buttonClasses = `${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`;

  if (href) {
    return (
      <a href={href} className={buttonClasses}>
        {icon && <span>{icon}</span>}
        {children}
      </a>
    );
  }

  return (
    <button className={buttonClasses} onClick={onClick} disabled={disabled}>
      {icon && <span>{icon}</span>}
      {children}
    </button>
  );
};
