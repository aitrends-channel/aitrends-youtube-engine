"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copies one string, and says so for a moment.
 *
 * The confirmation is the icon itself, a check where the copy mark was. A
 * toast would announce something nobody needs announced, and it would land
 * across the screen from the thing that was copied.
 *
 * The click is stopped and cancelled here because these sit on rows and cards
 * that are themselves links: copying an address is not asking to open what it
 * points at, and stopPropagation alone would not hold back an anchor.
 */
export function CopyButton({ text, title = "Copy", size = 13, className = "", style }: {
  text: string;
  title?: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void navigator.clipboard.writeText(text)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => { /* a browser that refuses the clipboard says so itself */ });
      }}
      className={`shrink-0 flex items-center justify-center rounded transition-all cursor-pointer hover:opacity-80 ${className}`}
      style={{ color: copied ? "oklch(0.7 0.15 145)" : "var(--c-45)", ...style }}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
