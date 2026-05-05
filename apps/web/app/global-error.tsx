"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#050714",
          color: "#f0f4ff",
          fontFamily: "Inter, system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            textAlign: "center",
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(13,18,48,0.85)",
            borderRadius: 24,
            padding: "2rem",
          }}
        >
          <p
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              letterSpacing: "0.28em",
              textTransform: "uppercase",
              color: "#f59e0b",
              marginBottom: 12,
            }}
          >
            Critical error
          </p>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>
            NumeriQ hit an unexpected error
          </h1>
          <p style={{ color: "#8b92b8", fontSize: 14, marginBottom: 24 }}>
            The team has been notified. Please retry or sign in again.
          </p>
          {error?.digest ? (
            <p
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "#8b92b8",
                marginBottom: 16,
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              borderRadius: 9999,
              padding: "0.625rem 1.25rem",
              fontSize: 14,
              fontWeight: 600,
              color: "white",
              background: "linear-gradient(135deg, #3b82f6, #7c3aed)",
              border: "none",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
