import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { collaborationTestIds } from "../testIds";
import { IssueConversationDrawerContext } from "./issueConversationDrawerContext";

interface IssueConversationDrawersProps {
  label: string;
  children: (close: () => void) => ReactNode;
  conversation: ReactNode;
  conversationKey?: string;
  onClose: () => void;
  onCloseConversation: () => void;
}

/** One overlay owns both panes, so the conversation cannot fall behind its Issue. */
export function IssueConversationDrawers({
  label,
  children,
  conversation,
  conversationKey,
  onClose,
  onCloseConversation,
}: IssueConversationDrawersProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeCommittedRef = useRef(false);
  const [retainedConversation, setRetainedConversation] =
    useState(conversation);
  const [dismissing, setDismissing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hasConversation = Boolean(conversation);
  const requestClose = () => setDismissing(true);
  if (conversation && conversation !== retainedConversation) {
    setRetainedConversation(conversation);
  }

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!dismissing) {
      closeCommittedRef.current = false;
      if (hasConversation) return;
    }
    let active = true;
    const finishExit = async () => {
      // getAnimations flushes style and includes the transition started by this commit.
      // Re-check after cancellation (for example, resizing or enabling reduced motion).
      const runningAnimations = () =>
        (trackRef.current?.getAnimations() ?? []).filter(
          (animation) =>
            animation.playState !== "finished" &&
            animation.playState !== "idle",
        );
      let animations = runningAnimations();
      while (animations.length > 0) {
        await Promise.allSettled(
          animations.map((animation) => animation.finished),
        );
        if (!active) return;
        animations = runningAnimations();
      }
      if (!active) return;
      if (dismissing) {
        if (closeCommittedRef.current) return;
        closeCommittedRef.current = true;
        onCloseRef.current();
      } else {
        setRetainedConversation(null);
        setExpanded(false);
      }
    };
    void finishExit();
    return () => {
      active = false;
    };
  }, [hasConversation, dismissing]);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    containerRef.current
      ?.querySelector<HTMLElement>('[data-testid="cloud-todo-detail-close"]')
      ?.focus({ preventScroll: true });
    return () => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!hasConversation) return;
    const trigger = document.activeElement as HTMLElement | null;
    containerRef.current
      ?.querySelector<HTMLElement>('[data-testid="ai-chat-modal-close"]')
      ?.focus({ preventScroll: true });
    const pane = containerRef.current?.querySelector(
      ".issue-drawer-conversation",
    );
    return () => {
      if (
        trigger?.isConnected &&
        (document.activeElement === document.body ||
          pane?.contains(document.activeElement))
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [hasConversation, conversationKey]);

  return (
    <div
      ref={containerRef}
      className="issue-conversation-drawers-backdrop"
      data-testid={collaborationTestIds.issueDetail}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          if (hasConversation) onCloseConversation();
          else requestClose();
        }
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        if (event.key === "Escape") {
          event.stopPropagation();
          if (hasConversation) onCloseConversation();
          else requestClose();
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button, a[href], input, textarea, select, summary, [tabindex], [contenteditable="true"]',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            !element.closest("[inert]") &&
            element.getBoundingClientRect().right >
              (viewportRef.current?.getBoundingClientRect().left ?? 0) &&
            element.getBoundingClientRect().left <
              (viewportRef.current?.getBoundingClientRect().right ??
                Infinity) &&
            element.getClientRects().length > 0,
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div ref={viewportRef} className="issue-drawer-viewport">
        <div
          ref={trackRef}
          className="issue-conversation-drawers"
          data-testid="issue-conversation-drawers"
          data-has-conversation={hasConversation}
          data-conversation-expanded={expanded}
          data-dismissing={dismissing}
          inert={dismissing}
        >
          <div
            className="issue-drawer-surface issue-drawer-detail"
            inert={hasConversation && expanded}
          >
            {children(requestClose)}
          </div>
          <div
            className="issue-drawer-surface issue-drawer-conversation"
            inert={!hasConversation}
          >
            <IssueConversationDrawerContext.Provider
              value={{
                expanded,
                toggleExpanded: () => setExpanded((value) => !value),
              }}
            >
              {conversation || retainedConversation}
            </IssueConversationDrawerContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
