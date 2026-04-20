"use client";

import React from "react";

interface SparklineChartProps {
  data: number[];
  color?: "blue" | "violet" | "cyan" | "teal";
  width?: number;
  height?: number;
  strokeWidth?: number;
}

export const SparklineChart: React.FC<SparklineChartProps> = ({
  data,
  color = "blue",
  width = 150,
  height = 40,
  strokeWidth = 2,
}) => {
  if (!data || data.length < 2) {
    return <div>No data</div>;
  }

  const colorMap = {
    blue: "#3b82f6",
    violet: "#7c3aed",
    cyan: "#06b6d4",
    teal: "#14b8a6",
  };

  const minValue = Math.min(...data);
  const maxValue = Math.max(...data);
  const range = maxValue - minValue || 1;

  // Calculate points for SVG polyline
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - ((value - minValue) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
    >
      <defs>
        <linearGradient
          id={`gradient-${color}`}
          x1="0%"
          y1="0%"
          x2="0%"
          y2="100%"
        >
          <stop offset="0%" stopColor={colorMap[color]} stopOpacity="0.5" />
          <stop offset="100%" stopColor={colorMap[color]} stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {/* Gradient fill area */}
      <polyline
        points={`0,${height} ${points} ${width},${height}`}
        fill={`url(#gradient-${color})`}
        stroke="none"
      />
      {/* Line */}
      <polyline
        points={points}
        fill="none"
        stroke={colorMap[color]}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
