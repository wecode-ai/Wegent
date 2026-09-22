import { useCallback, useEffect, useRef } from "react";
import type { ProjectChatMessage } from "@wegent/chat-core";

/** Shared PC scroll policy: follow the submitted card, never unrelated incoming activity. */
export function useIssueActivityScroll({
  messages: threadMessages,
  loading,
  linear = true,
  compact = true,
  cardTestIdPrefix,
}: {
  messages: ProjectChatMessage[];
  loading: boolean;
  linear?: boolean;
  compact?: boolean;
  cardTestIdPrefix: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const followCardRef = useRef<string | null>(null);
  const scrollTaskCommentsToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const scroller = resolveTaskCommentScrollContainer(
        listRef.current,
        linear,
      );
      if (scroller) {
        if (typeof scroller.scrollTo === "function") {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior });
        } else {
          scroller.scrollTop = scroller.scrollHeight;
        }
      }
    },
    [linear],
  );

  // Card replies grow inside their own card; keep the card's bottom visible
  // (where the new reply and the streaming AI response appear) instead of
  // jumping to the end of the whole comment list.
  const revealCardBottom = useCallback(
    (cardId: string, behavior: ScrollBehavior = "auto") => {
      const card = listRef.current?.querySelector<HTMLElement>(
        `[data-testid="${cardTestIdPrefix}${cardId}"]`,
      );
      const scroller = resolveTaskCommentScrollContainer(
        listRef.current,
        linear,
      );
      if (!card || !scroller) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      if (cardRect.bottom > scrollerRect.bottom) {
        scroller.scrollTo({
          top: scroller.scrollTop + cardRect.bottom - scrollerRect.bottom + 12,
          behavior,
        });
      }
    },
    [linear, cardTestIdPrefix],
  );

  useEffect(() => {
    const scroller = resolveTaskCommentScrollContainer(listRef.current, linear);
    if (!scroller) return;
    const updateFollowState = () => {
      if (followCardRef.current) {
        const card = listRef.current?.querySelector<HTMLElement>(
          `[data-testid="${cardTestIdPrefix}${followCardRef.current}"]`,
        );
        if (!card) {
          followCardRef.current = null;
          return;
        }
        const cardBottom = card.getBoundingClientRect().bottom;
        const scrollerBottom = scroller.getBoundingClientRect().bottom;
        if (cardBottom > scrollerBottom + 24) followCardRef.current = null;
        return;
      }
    };
    scroller.addEventListener("scroll", updateFollowState, { passive: true });
    return () => scroller.removeEventListener("scroll", updateFollowState);
  }, [compact, linear, loading, threadMessages.length, cardTestIdPrefix]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (followCardRef.current) {
        revealCardBottom(followCardRef.current);
        const rootId = followCardRef.current;
        const followedRoot = threadMessages.find(
          (message) => message.messageId === rootId,
        );
        const followed = followedRoot
          ? {
              root: followedRoot,
              replies: threadMessages.filter(
                (message) => message.rootMessageId === rootId,
              ),
            }
          : null;
        if (!followed) {
          followCardRef.current = null;
          return;
        }
        const lastRun = [followed.root, ...followed.replies]
          .filter((message) => message.sender.type === "agent")
          .at(-1);
        if (
          lastRun &&
          [
            "completed",
            "failed",
            "interrupted",
            "stalled",
            "cancelled",
            "canceled",
          ].includes(lastRun.status)
        ) {
          followCardRef.current = null;
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [compact, loading, revealCardBottom, threadMessages]);

  return {
    listRef,
    followCard: (rootId: string) => {
      followCardRef.current = rootId;
    },
    scrollTaskCommentsToBottom,
    revealCardBottom,
  };
}

function findTaskCommentScrollContainer(
  element: HTMLElement | null,
): HTMLElement | null {
  if (!element) return null;
  let current: HTMLElement | null = element;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (
      current.scrollHeight > current.clientHeight + 1 &&
      (overflowY === "auto" || overflowY === "scroll")
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveTaskCommentScrollContainer(
  element: HTMLElement | null,
  linear: boolean,
): HTMLElement | null {
  return linear ? element : findTaskCommentScrollContainer(element);
}
