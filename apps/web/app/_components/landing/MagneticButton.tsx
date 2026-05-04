"use client";

import { useRef, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  href?: string;
  strength?: number;
}

export function MagneticButton({ children, className = "", onClick, href, strength = 0.3 }: Props) {
  const ref = useRef<HTMLElement>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) * strength;
    const dy = (e.clientY - cy) * strength;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  const handleMouseLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "translate(0, 0)";
    el.style.transition = "transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)";
  };

  const handleMouseEnter = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "transform 0.1s ease";
  };

  const shared = {
    ref: ref as React.RefObject<never>,
    onMouseMove: handleMouseMove,
    onMouseLeave: handleMouseLeave,
    onMouseEnter: handleMouseEnter,
    className,
    onClick,
  };

  if (href) {
    return <a href={href} {...shared}>{children}</a>;
  }
  return <button type="button" {...shared}>{children}</button>;
}
