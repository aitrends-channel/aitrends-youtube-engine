import type { SVGProps } from "react";

interface ImageSparkleProps extends SVGProps<SVGSVGElement> {
  size?: number;
  strokeWidth?: number;
}

/** Stylized "AI image generation" affordance — picture frame with a
 *  mountain + sun glyph inside and a 4-point sparkle outside, marking
 *  the image as something to *create* rather than *re-create*. Built
 *  inline to match lucide's stroke-based icon set; same prop surface
 *  (size, strokeWidth, className) so it drops into the existing
 *  icon-swap logic in the generate page without a wrapper. */
export function ImageSparkle({ size = 24, strokeWidth = 2, className, ...rest }: ImageSparkleProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {/* Picture frame — slightly inset to leave room for the sparkle */}
      <rect x="2" y="3" width="16" height="16" rx="3" />
      {/* Sun / small circle, upper-right inside the frame */}
      <circle cx="13" cy="8" r="1.5" />
      {/* Mountain — diagonal stroke from the bottom-left up to mid-frame */}
      <path d="M2 16 L7 11 L13 17" />
      {/* 4-point sparkle outside the frame, bottom-right */}
      <path d="M19 14 L20 17 L23 18 L20 19 L19 22 L18 19 L15 18 L18 17 Z" />
    </svg>
  );
}
