import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Bot,
  Check,
  ExternalLink,
  Hash,
  Monitor,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { CompositedSpinner } from "./CompositedSpinner";
import { activityClassNames as cn } from "./activityClassNames";
import {
  executionDisplayStatus,
  isExecutionCancellable,
} from "./executionStatus";
import { useCollaborationPortalTheme } from "../theme/CollaborationTheme";
import type { CollaborationTranslate } from "../i18n";
import { truncateRuntimeTaskTitle } from "@wegent/chat-core/runtime-task-title";

export interface RuntimeExecutionDetailsProps {
  senderName: string;
  taskTitle?: string | null;
  runId: string;
  modelName: string;
  deviceName: string;
  runStatus?: string | null;
  executionRunning?: boolean;
  transcriptUnavailable?: boolean;
  transcriptError?: string | null;
  onRetryTranscript: () => void;
  onStop?: () => Promise<void>;
  onOpenTask?: () => void | Promise<void>;
  onClose: () => void;
  translate: CollaborationTranslate;
  children: ReactNode;
}

/** One execution dialog; hosts supply the authoritative session and runtime actions. */
export function RuntimeExecutionDetails({
  senderName,
  taskTitle,
  runId: resolvedRunId,
  modelName: resolvedModel,
  deviceName,
  runStatus,
  executionRunning,
  transcriptUnavailable = false,
  transcriptError,
  onRetryTranscript,
  onStop,
  onOpenTask,
  onClose,
  translate: t,
  children,
}: RuntimeExecutionDetailsProps) {
  const portalTheme = useCollaborationPortalTheme();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const displayStatus = executionDisplayStatus(runStatus) ?? "unknown";
  const cancellable =
    executionRunning !== false &&
    Boolean(onStop) &&
    isExecutionCancellable(displayStatus);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleStop = async () => {
    if (stopping || !onStop) return;
    setStopping(true);
    setStopError(null);
    try {
      await onStop();
    } catch (cause) {
      setStopError(
        cause instanceof Error
          ? cause.message
          : t("activity.task_activity_stop_failed"),
      );
    } finally {
      setStopping(false);
    }
  };

  const statusContent = (() => {
    if (displayStatus === "succeeded") {
      return (
        <>
          <Check className="h-3 w-3" />
          {t("activity.queue_state_succeeded")}
        </>
      );
    }
    if (displayStatus === "failed") {
      return (
        <>
          <X className="h-3 w-3" />
          {t("activity.queue_state_failed")}
        </>
      );
    }
    if (displayStatus === "cancelled" || displayStatus === "skipped") {
      return (
        <>
          <Square className="h-3 w-3" />
          {t(
            displayStatus === "cancelled"
              ? "activity.queue_state_cancelled"
              : "activity.queue_state_skipped",
          )}
        </>
      );
    }
    const labelKey = {
      waiting_approval: "activity.queue_state_pending_approval",
      queued: "activity.queue_state_queued",
      starting: "activity.queue_state_starting",
      waiting_runtime: "activity.queue_state_waiting_runtime",
      running: "activity.queue_state_running",
      cancelling: "activity.queue_state_cancelling",
      unknown: "activity.queue_state_unknown",
    }[displayStatus];
    return (
      <>
        {displayStatus === "unknown" ? (
          <AlertCircle className="h-3 w-3" />
        ) : (
          <CompositedSpinner className="h-3 w-3" />
        )}
        {t(labelKey)}
      </>
    );
  })();

  const statusClassName = "bg-muted text-text-secondary";

  return createPortal(
    <div
      {...portalTheme}
      className={cn(
        portalTheme.className,
        "fixed inset-0 z-modal flex items-center justify-center bg-black/10 p-6",
      )}
      role="dialog"
      aria-modal="true"
      aria-label={t("activity.task_activity_execution_details")}
      data-testid="runtime-execution-detail-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[min(620px,84vh)] w-[min(780px,92vw)] flex-col overflow-hidden rounded-[20px] border border-border/50 bg-background shadow-[0_16px_44px_rgba(0,0,0,0.12)]">
        <header className="flex flex-none items-start gap-3 px-6 pb-4 pt-5">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-violet-600 text-background">
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-text-primary">
                {senderName}
              </span>
              <span
                className={cn(
                  "inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                  statusClassName,
                )}
                data-testid="runtime-execution-detail-status"
              >
                {statusContent}
              </span>
            </div>
            <h2 className="mt-1 truncate text-sm font-semibold text-text-primary">
              {truncateRuntimeTaskTitle(taskTitle) ??
                t("activity.task_activity_ai_execution")}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Hash className="h-3 w-3" />
                {t("activity.task_activity_execution_run")}: {resolvedRunId}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Bot className="h-3 w-3" />
                {t("activity.task_activity_execution_model")}: {resolvedModel}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Monitor className="h-3 w-3" />
                {t("activity.task_activity_execution_device")}: {deviceName}
              </span>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="runtime-execution-detail-close"
            aria-label={t("activity.close_dialog", "关闭")}
            onClick={onClose}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div
          className="min-h-0 flex-1 flex flex-col"
          data-testid="runtime-execution-detail-body"
        >
          {transcriptError && !transcriptUnavailable ? (
            <div
              role="alert"
              className="flex items-center gap-3 border-b border-border/50 bg-muted px-6 py-2 text-xs text-text-secondary"
            >
              <span className="min-w-0 flex-1">{transcriptError}</span>
              <button
                type="button"
                data-testid="runtime-execution-detail-history-retry"
                onClick={onRetryTranscript}
                className="shrink-0 rounded-md px-2 py-1 hover:bg-surface"
              >
                {t("activity.retry")}
              </button>
            </div>
          ) : null}
          {transcriptUnavailable ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
              data-testid="runtime-execution-detail-transcript-error"
            >
              <AlertCircle className="h-5 w-5 text-text-muted" />
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {t("activity.task_activity_transcript_unavailable")}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {t(
                    executionRunning === false
                      ? "activity.task_activity_transcript_execution_idle"
                      : executionRunning === true
                        ? "activity.task_activity_transcript_execution_continues"
                        : "activity.task_activity_transcript_execution_unknown",
                  )}
                </p>
              </div>
              <button
                type="button"
                data-testid="runtime-execution-detail-transcript-retry"
                onClick={onRetryTranscript}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-3 text-sm font-medium text-text-primary hover:bg-muted/80"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("activity.retry")}
              </button>
            </div>
          ) : (
            children
          )}
        </div>

        <footer className="flex flex-none items-center gap-3 border-t border-border/50 px-6 py-3">
          {cancellable ? (
            <button
              type="button"
              data-testid="runtime-execution-detail-stop"
              onClick={() => void handleStop()}
              disabled={stopping}
              className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
            >
              {stopping ? (
                <CompositedSpinner className="h-3.5 w-3.5" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {t("activity.task_activity_stop_execution")}
            </button>
          ) : null}
          {stopError ? (
            <span
              className="min-w-0 flex-1 truncate text-xs text-red-600"
              role="alert"
            >
              {stopError}
            </span>
          ) : null}
          <span className="flex-1" />
          {onOpenTask ? (
            <button
              type="button"
              data-testid="runtime-execution-detail-open-page"
              onClick={() => void onOpenTask?.()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-blue-600 hover:bg-blue-500/10 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("activity.task_activity_open_in_task_page")}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="runtime-execution-detail-footer-close"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t("activity.close_dialog", "关闭")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
