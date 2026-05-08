"use client";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f0a0f",
          color: "#e8e8e8",
          fontFamily: "system-ui, sans-serif",
          gap: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600 }}>
          Something went wrong
        </h2>
        {error.digest && (
          <p style={{ margin: 0, fontSize: "0.75rem", color: "#888" }}>
            Error ID: {error.digest}
          </p>
        )}
        <button
          onClick={unstable_retry}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: "0.5rem",
            border: "none",
            background: "oklch(0.72 0.25 285)",
            color: "#fff",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
