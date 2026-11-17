import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { collaborationTestIds } from "../testIds";
import { createIssueDrawerDiagnostic } from "./issueDrawerDiagnostics";

interface IssueConversationDrawersProps {
  embedded?: boolean;
  label: string;
  children: (close: () => void) => ReactNode;
  conversation: ReactNode;
  conversationKey?: string;
  onClose: () => void;
  onCloseConversation: () => void;
}

/** One overlay owns both panes, so the conversation cannot fall behind its Issue. */
export function IssueConversationDrawers({
  embedded = false,
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
  const [diagnostic] = useState(createIssueDrawerDiagnostic);
  const [retainedConversation, setRetainedConversation] =
    useState(conversation);
  const [dismissing, setDismissing] = useState(false);
  const hasConversation = Boolean(conversation);
  const requestClose = () => {
    diagnostic.record("request-close");
    setDismissing(true);
  };
  onCloseRef.current = onClose;
  if (conversation && conversation !== retainedConversation) {
    setRetainedConversation(conversation);
  }

  useLayoutEffect(() => {
    if (!dismissing) {
      closeCommittedRef.current = false;
      if (hasConversation) return;
    }
    let active = true;
    let settled = false;
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
      diagnostic.record("wait-animations", animations);
      while (animations.length > 0) {
        const results = await Promise.allSettled(
          animations.map((animation) => animation.finished),
        );
        diagnostic.record(
          "animations-settled",
          animations,
          results.filter((result) => result.status === "rejected").length,
        );
        if (!active) return;
        animations = runningAnimations();
        diagnostic.record("wait-animations", animations);
      }
      if (!active) return;
      settled = true;
      if (dismissing) {
        if (closeCommittedRef.current) return;
        closeCommittedRef.current = true;
        diagnostic.record("commit-callback");
        onCloseRef.current();
      } else setRetainedConversation(null);
    };
    void finishExit();
    return () => {
      active = false;
      if (!settled) diagnostic.record("effect-canceled");
    };
  }, [hasConversation, dismissing, diagnostic]);

  useEffect(() => {
    diagnostic.record("mounted");
    return () => diagnostic.record("unmounted");
  }, [diagnostic]);

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
      className={`issue-conversation-drawers-backdrop${embedded ? " issue-conversation-drawers-embedded" : ""}`}
      data-testid={collaborationTestIds.issueDetail}
      role={embedded ? "region" : "dialog"}
      aria-modal={embedded ? undefined : true}
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
        if (embedded || event.key !== "Tab") return;
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
          data-diagnostic-instance={diagnostic.instanceId}
          data-has-conversation={hasConversation}
          data-dismissing={dismissing}
          inert={dismissing}
        >
          <div className="issue-drawer-surface issue-drawer-detail">
            {children(requestClose)}
          </div>
          <div
            className="issue-drawer-surface issue-drawer-conversation"
            inert={!hasConversation}
          >
            {conversation || retainedConversation}
          </div>
        </div>
      </div>
    </div>
  );
}
