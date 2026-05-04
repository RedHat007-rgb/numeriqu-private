"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "../components/ui/Button";
import { Surface } from "../components/ui/Surface";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.error(error);
    }
  }, [error]);

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6 py-16">
      <Surface className="w-full max-w-lg space-y-5 p-8 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-feedback-warning">
          Something went sideways
        </p>
        <h1 className="text-3xl font-bold text-text-primary">
          We hit a snag rendering this page
        </h1>
        <p className="text-sm text-text-muted">
          The issue has been logged. You can retry, or head back to the
          workspace if this keeps happening.
        </p>

        {error?.digest ? (
          <p className="font-mono text-[11px] text-text-muted">
            Reference: <span className="text-text-secondary">{error.digest}</span>
          </p>
        ) : null}

        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button onClick={() => reset()}>Try again</Button>
          <Link href="/dashboard">
            <Button variant="secondary">Back to dashboard</Button>
          </Link>
        </div>
      </Surface>
    </main>
  );
}
