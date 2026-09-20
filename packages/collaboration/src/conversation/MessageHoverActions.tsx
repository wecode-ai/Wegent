import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TransitionEvent as ReactTransitionEvent,
} from "react";
import { Check, Copy, Pencil } from "lucide-react";
import type { WorkbenchMessage } from "@wegent/chat-core/runtime-conversation";
import { useMarkdownServices } from "../markdown/MarkdownServices";
import { useConversationTranslation } from "./ConversationTranslation";

function ForkTurnIcon() {
  return (
    <svg
      data-testid="fork-message-icon"
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12h4c4 0 4-6 8-6h6" />
      <path d="M7 12c4 0 4 6 8 6h6" />
      <path d="m18 3 3 3-3 3" />
      <path d="m18 15 3 3-3 3" />
    </svg>
  );
}

const RECENT_MESSAGE_TIME_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
function formatMessageTime(
  createdAt: string,
  t: ReturnType<typeof useConversationTranslation>["t"],
) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (isToday) return time;

  const ageMs = now.getTime() - date.getTime();
  if (ageMs >= 0 && ageMs < RECENT_MESSAGE_TIME_RANGE_MS) {
    return `${t(`message_time.weekday_${date.getDay()}`)}${time}`;
  }

  const dateLabel = t("message_time.month_day", {
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
  if (date.getFullYear() === now.getFullYear()) {
    return `${dateLabel} ${time}`;
  }

  return t("message_time.year_date", {
    year: date.getFullYear(),
    date: dateLabel,
    time,
  });
}

export function MessageHoverActions({
  message,
  copyContent = message.content,
  align,
  visible,
  onEdit,
  onFork,
}: {
  message: WorkbenchMessage;
  copyContent?: string;
  align: "left" | "right";
  visible: boolean;
  onEdit?: () => void;
  onFork?: () => Promise<void> | void;
}) {
  const { t } = useConversationTranslation();
  const { copyText } = useMarkdownServices();
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const resetCopiedAfterHideRef = useRef(false);
  const time = formatMessageTime(message.createdAt, t);

  useEffect(() => {
    if (!visible && copied) {
      resetCopiedAfterHideRef.current = true;
    }
  }, [copied, visible]);

  const handleCopy = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail > 0) {
      event.currentTarget.blur();
    }
    void copyText(copyContent).then(() => {
      setCopied(true);
      resetCopiedAfterHideRef.current = false;
    });
  };

  const handleLeaveActions = () => {
    if (copied) {
      resetCopiedAfterHideRef.current = true;
    }
  };

  const handleActionsTransitionEnd = (
    event: ReactTransitionEvent<HTMLDivElement>,
  ) => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "opacity" ||
      !resetCopiedAfterHideRef.current
    ) {
      return;
    }

    resetCopiedAfterHideRef.current = false;
    setCopied(false);
  };

  const copyAction = (
    <span
      data-testid="copy-message-action"
      className="group/copy relative flex h-6 w-6 items-center justify-center"
    >
      <button
        type="button"
        data-testid="copy-message-button"
        onClick={handleCopy}
        title={t("message_actions.copy")}
        className={[
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          copied
            ? "bg-text-primary text-background/70 shadow-sm hover:bg-text-primary/90 hover:text-background/80"
            : "text-text-muted hover:bg-muted hover:text-text-secondary",
        ].join(" ")}
        aria-label={t(
          copied ? "message_actions.copied" : "message_actions.copy_message",
        )}
      >
        {copied ? (
          <Check
            data-testid="copy-message-success-icon"
            className="h-4 w-4"
            strokeWidth={2.2}
          />
        ) : (
          <Copy data-testid="copy-message-icon" className="h-3.5 w-3.5" />
        )}
      </button>
      <span
        data-testid="copy-message-label"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-base px-1.5 py-0.5 text-xs text-text-secondary opacity-0 shadow-sm transition-opacity group-hover/copy:opacity-100"
      >
        {t("message_actions.copy")}
      </span>
    </span>
  );

  const editAction = onEdit ? (
    <span
      data-testid="edit-message-action"
      className="group/edit relative flex h-6 w-6 items-center justify-center"
    >
      <button
        type="button"
        data-testid="edit-message-button"
        onClick={(event) => {
          if (event.detail > 0) {
            event.currentTarget.blur();
          }
          onEdit();
        }}
        title={t("message_actions.edit")}
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-secondary"
        aria-label={t("message_actions.edit_message")}
      >
        <Pencil data-testid="edit-message-icon" className="h-3.5 w-3.5" />
      </button>
      <span
        data-testid="edit-message-label"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-base px-1.5 py-0.5 text-xs text-text-secondary opacity-0 shadow-sm transition-opacity group-hover/edit:opacity-100"
      >
        {t("message_actions.edit")}
      </span>
    </span>
  ) : null;

  const forkAction = onFork ? (
    <span className="group/fork relative flex h-6 w-6 items-center justify-center">
      <button
        type="button"
        data-testid="fork-message-button"
        onClick={() => {
          if (forking) return;
          setForking(true);
          void (async () => {
            try {
              await onFork();
            } catch {
              // The workbench callback owns user-visible error reporting.
            } finally {
              setForking(false);
            }
          })();
        }}
        disabled={forking}
        title={t("continue_in_new_task")}
        aria-label={t("continue_in_new_task")}
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-secondary disabled:pointer-events-none disabled:opacity-50"
      >
        <ForkTurnIcon />
      </button>
      <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-base px-1.5 py-0.5 text-xs text-text-secondary opacity-0 shadow-sm transition-opacity group-hover/fork:opacity-100">
        {t("continue_in_new_task")}
      </span>
    </span>
  ) : null;

  const timeLabel = time ? (
    <span
      data-testid="message-hover-time"
      className="select-none whitespace-nowrap px-1 text-xs text-text-muted"
    >
      {time}
    </span>
  ) : null;

  return (
    <div
      data-testid="message-hover-actions"
      onMouseLeave={handleLeaveActions}
      onTransitionEnd={handleActionsTransitionEnd}
      className={[
        "flex min-h-5 select-none items-center gap-1 text-xs text-text-muted transition-opacity duration-150",
        visible
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0",
        align === "right" ? "justify-end" : "justify-start",
      ].join(" ")}
    >
      {align === "right" ? (
        <>
          {timeLabel}
          {copyAction}
          {editAction}
        </>
      ) : (
        <>
          {editAction}
          {copyAction}
          {forkAction}
          {timeLabel}
        </>
      )}
    </div>
  );
}
