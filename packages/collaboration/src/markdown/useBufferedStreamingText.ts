import { useEffect, useRef, useState } from "react";
import {
  cancelSafeAnimationFrame,
  requestSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from "./safeAnimationFrame";

const FALLBACK_FLUSH_MS = 100;

export function useBufferedStreamingText(
  content: string,
  isStreaming: boolean,
  flushIntervalMs = 0,
): string {
  const [bufferedContent, setBufferedContent] = useState(content);
  const targetContentRef = useRef(content);
  const bufferedContentRef = useRef(content);
  const frameRef = useRef<SafeAnimationFrameHandle | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    targetContentRef.current = content;

    const cancelFrame = () => {
      if (frameRef.current === null) return;
      cancelSafeAnimationFrame(frameRef.current);
      frameRef.current = null;
    };

    const cancelFallbackTimer = () => {
      if (fallbackTimerRef.current === null) return;
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    };

    const syncLatestContent = () => {
      cancelFrame();
      cancelFallbackTimer();
      if (batchTimerRef.current !== null) clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
      const target = targetContentRef.current;
      bufferedContentRef.current = target;
      setBufferedContent(target);
    };

    if (
      !isStreaming ||
      !content.startsWith(bufferedContentRef.current) ||
      (flushIntervalMs > 0 && !bufferedContentRef.current)
    ) {
      syncLatestContent();
      return;
    }

    if (
      frameRef.current === null &&
      batchTimerRef.current === null &&
      bufferedContentRef.current !== content
    ) {
      const scheduleFrame = () => {
        batchTimerRef.current = null;
        frameRef.current = requestSafeAnimationFrame(syncLatestContent);
        fallbackTimerRef.current = setTimeout(
          syncLatestContent,
          FALLBACK_FLUSH_MS,
        );
      };
      // Keep one deadline while deltas arrive; restarting it could starve the tail.
      if (flushIntervalMs > 0)
        batchTimerRef.current = setTimeout(scheduleFrame, flushIntervalMs);
      else scheduleFrame();
    }
  }, [content, isStreaming, flushIntervalMs]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelSafeAnimationFrame(frameRef.current);
      if (fallbackTimerRef.current !== null)
        clearTimeout(fallbackTimerRef.current);
      if (batchTimerRef.current !== null) clearTimeout(batchTimerRef.current);
    },
    [],
  );

  return isStreaming && content.startsWith(bufferedContent)
    ? bufferedContent
    : content;
}
