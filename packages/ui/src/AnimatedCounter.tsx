"use client";

import React, { useEffect, useState } from "react";

interface AnimatedCounterProps {
  value: string;
  label: string;
  duration?: number;
}

export const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  label,
  duration = 2000,
}) => {
  const [displayValue, setDisplayValue] = useState("0");

  useEffect(() => {
    // Extract numeric part from value string
    const numericValue = parseInt(value.replace(/[^0-9]/g, ""), 10);
    const suffix = value.replace(/[0-9]/g, "");

    if (!numericValue) return;

    let current = 0;
    const increment = numericValue / (duration / 16); // 60fps
    const timer = setInterval(() => {
      current += increment;
      if (current >= numericValue) {
        setDisplayValue(numericValue + suffix);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current) + suffix);
      }
    }, 16);

    return () => clearInterval(timer);
  }, [value, duration]);

  return (
    <div className="flex flex-col items-center">
      <div className="text-3xl font-bold text-blue-400 font-mono">
        {displayValue}
      </div>
      <div className="text-sm text-muted font-mono tracking-widest">
        {label}
      </div>
    </div>
  );
};
