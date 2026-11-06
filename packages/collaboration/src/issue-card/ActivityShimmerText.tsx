import { useEffect, useRef } from "react";

const SHIMMER_TEXT_WIDTH = "--activity-shimmer-text-width";
const SHIMMER_TEXT_OFFSET = "--activity-shimmer-text-offset";

export function ActivityShimmerText({
  children,
  variant,
  className = "",
}: {
  children: string;
  variant: "thinking" | "tool";
  className?: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const text = textRef.current;
    if (!text || typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      text.style.setProperty(SHIMMER_TEXT_WIDTH, `${width}px`);
      text.style.setProperty(SHIMMER_TEXT_OFFSET, `${-width}px`);
    });
    resizeObserver.observe(text);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <span
      ref={textRef}
      className={`activity-shimmer-text ${variant === "thinking" ? "waiting-thinking-text" : "tool-activity-shimmer"} ${className}`}
    >
      {children}
      <span aria-hidden="true" className="activity-shimmer-highlight">
        <span className="activity-shimmer-sweep">
          <span className="activity-shimmer-band" data-text={children} />
        </span>
      </span>
    </span>
  );
}
