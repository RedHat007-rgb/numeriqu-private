import Link from "next/link";
import { Button } from "../components/ui/Button";
import { Surface } from "../components/ui/Surface";

export const metadata = {
  title: "Page not found · NumeriQ",
};

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6 py-16">
      <Surface className="w-full max-w-lg space-y-5 p-8 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent-blue">
          404 · Not found
        </p>
        <h1 className="text-3xl font-bold text-text-primary">
          We couldn&apos;t find that page
        </h1>
        <p className="text-sm text-text-muted">
          The link may be old or the page was moved. Try one of the entry
          points below to get back on track.
        </p>

        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/">
            <Button>Go to landing</Button>
          </Link>
          <Link href="/dashboard">
            <Button variant="secondary">Open dashboard</Button>
          </Link>
        </div>
      </Surface>
    </main>
  );
}
