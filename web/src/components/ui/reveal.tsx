import type { CSSProperties, ElementType, ReactNode } from "react";

/**
 * Marks a block to animate in as it scrolls into view.
 *
 * The motion lives entirely in CSS (`animation-timeline: view()`), so there is no
 * client component, no scroll listener and no observer. Where the property is
 * unsupported, or the visitor prefers reduced motion, the content just renders.
 *
 * `index` staggers siblings that enter the viewport together by offsetting the
 * animation range rather than delaying in time.
 */
export function Reveal({
  children,
  as: Tag = "div",
  index = 0,
  className = "",
}: {
  children: ReactNode;
  as?: ElementType;
  index?: number;
  className?: string;
}) {
  return (
    <Tag
      data-reveal=""
      style={index ? ({ "--reveal-i": index } as CSSProperties) : undefined}
      className={className}
    >
      {children}
    </Tag>
  );
}
