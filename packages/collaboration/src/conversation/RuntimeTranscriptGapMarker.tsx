import { useEffect, useRef } from "react";

import type { RefObject } from "react";
import { useConversationTranslation } from "./ConversationTranslation";
import { activityClassNames as cn } from "../issue-detail/activityClassNames";

import type { WorkbenchMessage } from "@wegent/chat-core/runtime-conversation";

import {
  type RuntimeTranscriptGap,
  type RuntimeTranscriptRange,
} from "./scrollableMessageTypes";
export function RuntimeTranscriptGapMarker({
  gap,
  loading,
  scrollRef,
  onLoad,
}: {
  gap: RuntimeTranscriptGap;
  loading: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onLoad?: (
    gap: RuntimeTranscriptGap,
    reason: "visible" | "click",
  ) => Promise<void>;
}) {
  const { t } = useConversationTranslation();
  const markerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loading || !onLoad) return;
    const marker = markerRef.current;
    const scroller = scrollRef.current;
    if (!marker || !scroller || typeof IntersectionObserver === "undefined")
      return;

    let triggered = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (triggered || !entries.some((entry) => entry.isIntersecting)) return;
        triggered = true;
        void onLoad(gap, "visible");
      },
      {
        root: scroller,
        rootMargin: "160px 0px",
        threshold: 0.01,
      },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [gap, loading, onLoad, scrollRef]);

  return (
    <div
      ref={markerRef}
      className="mx-auto flex w-full max-w-3xl justify-center px-6 py-1"
      data-runtime-transcript-gap={`${gap.start}:${gap.end}`}
      data-testid="runtime-transcript-gap-marker"
    >
      <button
        type="button"
        disabled={loading || !onLoad}
        onClick={() => void onLoad?.(gap, "click")}
        data-testid="load-runtime-transcript-gap-button"
        className="flex min-h-[36px] min-w-[44px] items-center gap-2 rounded-full border border-border bg-background px-3 text-xs font-medium text-text-secondary shadow-sm hover:bg-muted disabled:cursor-wait disabled:opacity-80"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full bg-primary opacity-80",
            loading && "animate-pulse",
          )}
        />
        <span>
          {loading
            ? t("message_navigation.loading_gap")
            : t("message_navigation.gap_missing")}
        </span>
      </button>
    </div>
  );
}

export function runtimeTranscriptGapBetween(
  message: WorkbenchMessage,
  nextMessage: WorkbenchMessage | undefined,
  loadedRanges: RuntimeTranscriptRange[] | undefined,
): RuntimeTranscriptGap | null {
  if (!nextMessage) return null;
  const currentIndex = runtimeMessageIndex(message);
  const nextIndex = runtimeMessageIndex(nextMessage);
  if (
    currentIndex === null ||
    nextIndex === null ||
    nextIndex <= currentIndex + 1
  )
    return null;

  let gapStart = currentIndex + 1;
  const gapEnd = nextIndex;
  const sortedRanges = [...(loadedRanges ?? [])]
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);

  for (const range of sortedRanges) {
    if (range.end <= gapStart) continue;
    if (range.start > gapStart) {
      return { start: gapStart, end: Math.min(range.start, gapEnd) };
    }
    gapStart = Math.max(gapStart, range.end);
    if (gapStart >= gapEnd) return null;
  }

  return { start: gapStart, end: gapEnd };
}

export function runtimeMessageIndex(message: WorkbenchMessage): number | null {
  return typeof message.runtimeMessageIndex === "number" &&
    Number.isFinite(message.runtimeMessageIndex)
    ? message.runtimeMessageIndex
    : null;
}

export function runtimeTranscriptGapKey(gap: RuntimeTranscriptGap): string {
  return `${gap.start}:${gap.end}`;
}
