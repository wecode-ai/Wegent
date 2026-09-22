import {
  AlertCircle,
  Bot,
  Check,
  CircleCheck,
  CircleSlash,
  Clock3,
  Copy,
  ChevronRight,
  ExternalLink,
  Hash,
  LoaderCircle,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { activityDisplayBody } from "./activityDisplayBody";
import {
  IssueActivityAvatar,
  IssueActivityMessage,
} from "./IssueActivityPresentation";
import { IssueActivityMarkdown } from "./IssueActivityMarkdown";
import type { ProjectChatMessage } from "@wegent/chat-core";
import type { CollaborationTranslate } from "../i18n";
import { CompositedSpinner } from "./CompositedSpinner";
import { Tooltip } from "./Tooltip";
import { activityClassNames as cn } from "./activityClassNames";
import { executionDisplayStatus } from "./executionStatus";
import {
  resolveMessageRunStatus,
  backendTaskExecution,
  type IssueActivityAiState,
} from "./activityMessageUtils";
import { IssueActivityContent } from "./IssueActivityContent";

export interface ExecutionTaskSummary {
  title: string;
  stageName: string | null;
  onOpen?: () => void;
}

type TaskExecutionStatusKind =
  | "waiting_approval"
  | "queued"
  | "starting"
  | "waiting_runtime"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "unknown"
  | "interrupted";

function taskExecutionStatusKind(status: string): TaskExecutionStatusKind {
  if (status.toLowerCase() === "interrupted") return "interrupted";
  return executionDisplayStatus(status) ?? "unknown";
}

export function IssueExecutionStatusControl({
  translate: t,
  copyText,
  taskId,
  status,
  error,
  note,
  approvalLabel,
}: {
  translate: CollaborationTranslate;
  copyText(text: string): Promise<unknown>;
  taskId: string;
  status: string;
  error?: string | null;
  note?: string | null;
  approvalLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const kind = taskExecutionStatusKind(status);
  const labels: Record<TaskExecutionStatusKind, string> = {
    waiting_approval:
      approvalLabel ?? t("activity.queue_state_pending_approval"),
    queued: t("activity.queue_state_queued"),
    starting: t("activity.queue_state_starting"),
    waiting_runtime: t("activity.queue_state_waiting_runtime"),
    running: t("activity.queue_state_running"),
    cancelling: t("activity.queue_state_cancelling"),
    succeeded: t("activity.task_activity_status_succeeded"),
    failed: t("activity.task_activity_status_failed"),
    cancelled: t("activity.queue_state_cancelled"),
    skipped: t("activity.queue_state_skipped"),
    unknown: t("activity.queue_state_unknown"),
    interrupted: t("activity.task_activity_status_interrupted"),
  };
  const label = labels[kind];
  const Icon =
    kind === "succeeded"
      ? CircleCheck
      : kind === "failed"
        ? AlertCircle
        : kind === "cancelled" || kind === "skipped" || kind === "interrupted"
          ? CircleSlash
          : ["waiting_approval", "queued", "waiting_runtime"].includes(kind)
            ? Clock3
            : LoaderCircle;
  const animated = ["starting", "running", "cancelling"].includes(kind);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const copyDetails = async () => {
    const details = [
      `${t("activity.task_activity_status_label")}: ${label}`,
      error ? `${t("activity.task_activity_error_label")}: ${error}` : null,
      note ? `${t("activity.task_activity_note_label")}: ${note}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    await copyText(details);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span ref={rootRef} className="task-detail-execution-status-control">
      <Tooltip label={label} side="bottom" align="end">
        <button
          type="button"
          data-testid={`cloud-task-activity-execution-status-${taskId}`}
          data-status={kind}
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="task-detail-execution-status-trigger"
        >
          {animated ? (
            <CompositedSpinner icon={Icon} className="h-4 w-4" />
          ) : (
            <Icon className="h-4 w-4" />
          )}
        </button>
      </Tooltip>
      {open ? (
        <span
          role="dialog"
          aria-label={t("activity.task_activity_status_details")}
          data-testid={`cloud-task-activity-execution-details-${taskId}`}
          className="task-detail-execution-status-popover"
        >
          <span className="task-detail-execution-status-popover-head">
            <span className="task-detail-execution-status-popover-title">
              {animated ? (
                <CompositedSpinner icon={Icon} className="h-4 w-4" />
              ) : (
                <Icon className="h-4 w-4" />
              )}
              {label}
            </span>
            <button
              type="button"
              onClick={() => void copyDetails()}
              className="task-detail-execution-copy"
              aria-label={t("activity.task_activity_copy_details")}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied
                ? t("activity.task_activity_copied")
                : t("activity.task_activity_copy")}
            </button>
          </span>
          {error ? (
            <span
              data-testid={`cloud-task-activity-execution-error-${taskId}`}
              className="task-detail-execution-status-detail is-error"
            >
              <span>{t("activity.task_activity_error_label")}</span>
              <span>{error}</span>
            </span>
          ) : null}
          {note ? (
            <span
              data-testid={`cloud-task-activity-execution-note-${taskId}`}
              className="task-detail-execution-status-detail"
            >
              <span>{t("activity.task_activity_note_label")}</span>
              <span>{note}</span>
            </span>
          ) : null}
          {!error && !note ? (
            <span className="task-detail-execution-status-empty">
              {t("activity.task_activity_no_status_details")}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function IssueChatMessage({
  translate: t,
  onOpenUrl,
  onOpenAttachment,
  testId,
  executionTestId,
  message,
  mine,
  compact = false,
  plain = false,
  eventOnly = false,
  taskAiState,
  executionStatus,
  executionDeviceName,
  taskSummary,
  onOpenExecution,
  onStopExecution,
  stopping = false,
  flash = false,
}: {
  translate: CollaborationTranslate;
  onOpenUrl(url: string): void;
  onOpenAttachment?(id: string, filename: string): void;
  testId?: string;
  executionTestId?: string;
  message: ProjectChatMessage;
  mine: boolean;
  compact?: boolean;
  /** Render inside a parent comment card without the outer card border. */
  plain?: boolean;
  eventOnly?: boolean;
  taskAiState?: IssueActivityAiState | null;
  /** Presentation only; never changes comment lifecycle or content. */
  executionStatus?: string;
  /** Human-readable device name for this execution. */
  executionDeviceName?: string | null;
  taskSummary?: ExecutionTaskSummary;
  onOpenExecution?: () => void;
  onStopExecution?: () => void;
  stopping?: boolean;
  /** Momentarily highlight this comment, e.g. after a notification opened it. */
  flash?: boolean;
}) {
  const focusAttributes = {
    "data-message-id": message.messageId,
    "data-flash": flash ? "true" : undefined,
  };
  const text = activityDisplayBody(message.content, "");
  const isAgent = message.sender.type === "agent";
  const isSubagent = message.metadata.kind === "task_ai_subagent";
  const runId =
    typeof message.metadata.run_id === "string"
      ? message.metadata.run_id
      : null;
  const deviceName = executionDeviceName?.trim() || null;
  const modelName =
    typeof message.metadata.model === "string" ? message.metadata.model : null;
  const runStatus =
    executionStatus ?? resolveMessageRunStatus(taskAiState, message);
  const displayStatus = executionDisplayStatus(runStatus);
  const isStreaming =
    executionStatus === undefined
      ? message.status === "streaming"
      : displayStatus === "running";
  const isSucceeded =
    executionStatus === undefined
      ? message.status === "completed"
      : displayStatus === "succeeded";
  const backendExecution = isAgent ? backendTaskExecution(message) : null;
  const openBackendExecution = backendExecution
    ? () => {
        onOpenUrl(backendExecution.executionUrl);
      }
    : undefined;
  const openExecution = onOpenExecution ?? openBackendExecution;
  if (eventOnly) {
    return (
      <div
        {...focusAttributes}
        className="task-detail-run-event"
        data-testid={`task-activity-run-event-${message.messageId}`}
      >
        <Bot className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{message.sender.name}</span>
        {isAgent ? (
          <div className="task-detail-thread-execution">
            <ExecutionStatusBadge
              translate={t}
              testId={executionTestId}
              messageId={message.messageId}
              status={runStatus}
              onOpenExecution={openExecution}
              onStopExecution={onStopExecution}
              stopping={stopping}
            />
            {deviceName || runId || modelName ? (
              <details>
                <summary
                  data-testid={`task-activity-run-details-${message.messageId}`}
                >
                  {t(
                    isSubagent
                      ? "activity.task_activity_subagent_execution"
                      : "activity.task_activity_ai_execution",
                  )}
                </summary>
                <div className="task-detail-thread-run-metadata">
                  {deviceName ? (
                    <span>{deviceName}</span>
                  ) : runId ? (
                    <span>Run {runId}</span>
                  ) : null}
                  {modelName ? <span>{modelName}</span> : null}
                </div>
              </details>
            ) : (
              <span>
                {t(
                  isSubagent
                    ? "activity.task_activity_subagent_execution"
                    : "activity.task_activity_ai_execution",
                )}
              </span>
            )}
          </div>
        ) : null}
        <time
          dateTime={message.updatedAt}
          className="task-detail-run-event-time"
        >
          {message.updatedAt.slice(5, 16).replace("T", " ")}
        </time>
      </div>
    );
  }
  const mentionedAgents = Array.isArray(message.metadata.mentions)
    ? message.metadata.mentions.filter(
        (mention) =>
          typeof mention === "object" &&
          mention !== null &&
          (mention as Record<string, unknown>).type === "agent",
      )
    : [];
  const messageContent =
    plain || isAgent ? (
      <IssueActivityMarkdown
        content={text}
        isStreaming={isStreaming}
        translate={t}
        onOpenAttachment={onOpenAttachment}
      />
    ) : (
      <span className="whitespace-pre-wrap break-words">{text}</span>
    );
  const body = (
    <>
      {text ? (
        <div
          className={cn(
            "min-w-0 text-text-primary",
            compact ? "text-sm leading-6" : "text-chat",
          )}
        >
          {plain ? (
            <IssueActivityContent
              key={message.messageId}
              messageId={message.messageId}
              expandLabel={t("activity.task_activity_expand_content")}
              collapseLabel={t("activity.task_activity_collapse_content")}
            >
              {messageContent}
            </IssueActivityContent>
          ) : (
            messageContent
          )}
        </div>
      ) : message.type === "agent_status" &&
        !backendExecution &&
        (executionStatus === undefined || isStreaming) ? (
        <span className="text-sm text-text-muted">
          {t("activity.project_chat_processing_ellipsis")}
        </span>
      ) : null}
      {isAgent && !compact && isSucceeded ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted">
          <Check className="h-3 w-3" /> {t("activity.project_chat_completed")}
        </span>
      ) : null}
      {!isAgent && mentionedAgents.length > 0 ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-violet-600">
          <Bot className="h-3 w-3" /> {t("activity.project_chat_ai_received")}
        </span>
      ) : null}
      {isAgent && !compact && isStreaming ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted">
          <CompositedSpinner className="h-3 w-3" />
          {t("activity.project_chat_processing")}
        </span>
      ) : null}
      {backendExecution ? (
        <div
          data-testid={`cloud-task-activity-backend-task-${message.messageId}`}
          className="mt-2 flex min-w-0 items-center justify-between gap-3 rounded-lg bg-muted px-2.5 py-2 text-xs"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 text-text-secondary">
            <Hash className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {t("activity.task_activity_backend_task", undefined, {
                id: backendExecution.taskId,
              })}
            </span>
          </span>
          <button
            type="button"
            data-testid={`cloud-task-activity-open-backend-task-${message.messageId}`}
            onClick={openBackendExecution}
            className="inline-flex shrink-0 items-center gap-1 text-blue-600 hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t("activity.task_activity_open_in_task_page")}
          </button>
        </div>
      ) : null}
      {isAgent && !compact && openExecution && !backendExecution ? (
        <button
          type="button"
          data-testid={`cloud-task-activity-open-execution-${message.messageId}`}
          onClick={openExecution}
          className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("activity.task_activity_view_execution")}
        </button>
      ) : null}
    </>
  );
  const avatar = (
    <IssueActivityAvatar
      author={message.sender.name}
      agent={isAgent}
      compact={compact}
    />
  );

  if (compact) {
    if (isAgent && !plain) {
      return (
        <article
          {...focusAttributes}
          data-testid={
            testId ?? `cloud-task-activity-message-${message.messageId}`
          }
          data-side="left"
          className="task-detail-ai-run-card"
        >
          <div className="task-detail-ai-run-header">
            {avatar}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-text-primary">
                  {taskSummary?.title ?? message.sender.name}
                </span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                  {taskSummary?.stageName ??
                    (isSubagent
                      ? t("activity.task_activity_subagent_execution")
                      : t("activity.task_activity_ai_execution"))}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>{message.createdAt.slice(5, 16).replace("T", " ")}</span>
                {deviceName ? (
                  <span>{deviceName}</span>
                ) : runId ? (
                  <span>Run {runId.slice(0, 8)}</span>
                ) : null}
                {modelName ? <span>{modelName}</span> : null}
              </div>
            </div>
            <ExecutionStatusBadge
              translate={t}
              testId={executionTestId}
              messageId={message.messageId}
              status={runStatus}
              onOpenExecution={openExecution}
              onStopExecution={onStopExecution}
              stopping={stopping}
            />
          </div>
          <div className="task-detail-ai-run-body">
            {text ? (
              <div
                data-testid={`cloud-task-activity-task-summary-${message.messageId}`}
                className="task-detail-ai-run-summary"
              >
                <IssueActivityMarkdown
                  content={text}
                  isStreaming={isStreaming}
                  translate={t}
                  onOpenAttachment={onOpenAttachment}
                />
              </div>
            ) : null}
            {taskSummary?.onOpen ? (
              <button
                type="button"
                data-testid={`cloud-task-activity-open-task-${message.messageId}`}
                onClick={taskSummary.onOpen}
                className="task-detail-ai-run-open-task"
              >
                {t("activity.task_activity_open_task")}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </article>
      );
    }

    return (
      <IssueActivityMessage
        {...focusAttributes}
        author={message.sender.name}
        createdAt={message.createdAt}
        avatar={avatar}
        metadata={
          isSubagent ? (
            <span className="text-xs text-text-muted">
              {t("activity.task_activity_subagent_execution")}
            </span>
          ) : null
        }
        data-testid={
          testId ?? `cloud-task-activity-message-${message.messageId}`
        }
        data-side={mine ? "right" : "left"}
        className="task-detail-thread-message"
      >
        <div
          data-testid={
            taskSummary
              ? `cloud-task-activity-task-summary-${message.messageId}`
              : undefined
          }
        >
          {body}
        </div>
        {taskSummary ? (
          <div className="task-detail-thread-task-link">
            {taskSummary.onOpen ? (
              <button
                type="button"
                data-testid={`cloud-task-activity-open-task-${message.messageId}`}
                onClick={taskSummary.onOpen}
                className="task-detail-ai-run-open-task"
              >
                {taskSummary.title}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span>{taskSummary.title}</span>
            )}
            {taskSummary.stageName ? (
              <span>{taskSummary.stageName}</span>
            ) : null}
          </div>
        ) : null}
      </IssueActivityMessage>
    );
  }

  return (
    <article
      {...focusAttributes}
      data-testid={testId ?? `cloud-task-activity-message-${message.messageId}`}
      data-side={mine ? "right" : "left"}
      className="overflow-hidden rounded-xl border border-border bg-background shadow-sm"
    >
      <header className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">
            {message.sender.name}
          </span>
          <span className="block text-xs text-text-muted">
            {isAgent
              ? t("activity.task_activity_ai_execution")
              : t("activity.task_activity_comment")}
            {isAgent && modelName ? ` · ${modelName}` : ""}
          </span>
        </span>
        {backendExecution ? (
          <ExecutionStatusBadge
            translate={t}
            testId={executionTestId}
            messageId={message.messageId}
            status={runStatus}
            onOpenExecution={openExecution}
          />
        ) : null}
      </header>
      <div className="px-4 py-4">{body}</div>
    </article>
  );
}

function ExecutionStatusBadge({
  translate: t,
  testId,
  messageId,
  status,
  onOpenExecution,
  onStopExecution,
  stopping = false,
}: {
  translate: CollaborationTranslate;
  testId?: string;
  messageId: string;
  status: string;
  onOpenExecution?: () => void;
  onStopExecution?: () => void;
  stopping?: boolean;
}) {
  const kind = taskExecutionStatusKind(status);
  const terminal = [
    "succeeded",
    "failed",
    "cancelled",
    "skipped",
    "interrupted",
  ].includes(kind);
  const labels: Record<TaskExecutionStatusKind, string> = {
    waiting_approval: t("activity.queue_state_pending_approval"),
    queued: t("activity.queue_state_queued"),
    starting: t("activity.queue_state_starting"),
    waiting_runtime: t("activity.queue_state_waiting_runtime"),
    running: t("activity.queue_state_running"),
    cancelling: t("activity.queue_state_cancelling"),
    succeeded: t("activity.project_chat_completed"),
    failed: t("activity.task_activity_status_failed"),
    cancelled: t("activity.queue_state_cancelled"),
    skipped: t("activity.queue_state_skipped"),
    unknown: t("activity.queue_state_unknown"),
    interrupted: t("activity.task_activity_status_interrupted"),
  };
  const StatusIcon =
    kind === "succeeded"
      ? Check
      : kind === "failed"
        ? AlertCircle
        : kind === "cancelled" || kind === "skipped" || kind === "interrupted"
          ? CircleSlash
          : ["waiting_approval", "queued", "waiting_runtime"].includes(kind)
            ? Clock3
            : LoaderCircle;
  const animated = ["starting", "running", "cancelling"].includes(kind);
  const statusContent = (
    <>
      {animated ? (
        <CompositedSpinner icon={StatusIcon} className="h-3 w-3" />
      ) : (
        <StatusIcon className="h-3 w-3" />
      )}
      {labels[kind]}
    </>
  );

  return (
    <span
      className={cn(
        "task-detail-execution-pill",
        !onOpenExecution && "is-static",
      )}
      data-status={kind}
    >
      <button
        type="button"
        data-testid={
          testId ?? `cloud-task-activity-execution-badge-${messageId}`
        }
        data-status={kind}
        aria-label={labels[kind]}
        disabled={!onOpenExecution}
        onClick={onOpenExecution}
        className="task-detail-execution-main"
      >
        <span className="task-detail-execution-status">{statusContent}</span>
        <span className="task-detail-execution-hover">
          <ExternalLink className="h-3.5 w-3.5" />
          {t("activity.task_activity_view_execution")}
        </span>
      </button>
      {onStopExecution ? (
        <button
          type="button"
          disabled={terminal || stopping}
          title={t("activity.task_activity_stop_execution")}
          data-testid={`cloud-task-activity-stop-${messageId}`}
          aria-label={t("activity.task_activity_stop_execution")}
          className="task-detail-execution-stop"
          onClick={(event) => {
            event.stopPropagation();
            onStopExecution();
          }}
        >
          {stopping ? (
            <CompositedSpinner className="h-3 w-3" />
          ) : (
            <Square className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </span>
  );
}
