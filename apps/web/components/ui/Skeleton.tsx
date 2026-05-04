import { cn } from "./cn";

type SkeletonProps = React.HTMLAttributes<HTMLDivElement> & {
  height?: number | string;
  width?: number | string;
  rounded?: "sm" | "md" | "lg" | "xl" | "full";
};

const radius: Record<NonNullable<SkeletonProps["rounded"]>, string> = {
  sm: "rounded",
  md: "rounded-md",
  lg: "rounded-xl",
  xl: "rounded-2xl",
  full: "rounded-full",
};

export function Skeleton({
  height = "1rem",
  width = "100%",
  rounded = "md",
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <div
      aria-hidden
      {...rest}
      className={cn("skeleton", radius[rounded], className)}
      style={{ height, width, ...style }}
    />
  );
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          height="0.85rem"
          width={index === lines - 1 ? "60%" : "100%"}
        />
      ))}
    </div>
  );
}
