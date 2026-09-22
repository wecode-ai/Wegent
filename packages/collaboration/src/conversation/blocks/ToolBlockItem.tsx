import { useToolInteractionServices } from "../ToolInteractionServices";
import { useEffect, useState } from "react";
import { useConversationTranslation } from "../ConversationTranslation";
import type { ProcessingBlock, SubagentBlock } from "./types";
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from "../../markdown/MarkdownServices";
import { ActivityShimmerText } from "../../issue-card/ActivityShimmerText";
import { AssistantMarkdown } from "../../markdown/AssistantMarkdown";
import {
  AssistantPlanCard,
  type AssistantPlanOpenRequest,
} from "../AssistantPlanCard";
import { usePersistentDisclosure } from "./disclosureState";
import { processingBlockDisclosureKey } from "./disclosureKeys";
import { useReaderDisclosure } from "../ReaderDisclosure";
import {
  ProcessFileChangesBlockItem,
  type FileEditDurationsByBlock,
  useToolDuration,
} from "./ToolFileChanges";
import { getBlockLabel } from "./toolBlockLabels";
import {
  renderBlockDetail,
  hasBlockDetail,
  getWorkspaceFilePath,
} from "./ToolBlockDetails";

const RECONNECTING_DISPLAY_DELAY_MS = 10_000;

interface ToolBlockItemProps {
  block: Exclude<ProcessingBlock, SubagentBlock>;
  compact?: boolean;
  durationStartedAt?: number;
  durationEndAt?: number;
  fileEditDurations?: FileEditDurationsByBlock;
  forceExpanded?: boolean;
  disclosureScope?: string;
  onOpenWorkspaceFile?: (
    path: string,
    options?: WorkspaceFileOpenOptions,
  ) => void;
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void;
}

export function ToolBlockItem({
  block,
  compact = false,
  durationStartedAt,
  durationEndAt,
  fileEditDurations,
  forceExpanded = false,
  disclosureScope,
  onOpenWorkspaceFile,
  onOpenAssistantPlan,
}: ToolBlockItemProps) {
  const { t } = useConversationTranslation();
  const interactions = useToolInteractionServices();
  const [userExpanded, setUserExpanded] = usePersistentDisclosure(
    processingBlockDisclosureKey(disclosureScope, block.id),
  );
  const reportReaderDisclosure = useReaderDisclosure();
  const isRunning = block.status !== "done" && block.status !== "error";
  const reconnectingBlockId =
    block.type === "tool" &&
    block.toolName === "runtime_reconnecting" &&
    isRunning
      ? block.id
      : null;
  const showReconnectingStatus = useDelayedBlockVisibility(
    reconnectingBlockId,
    RECONNECTING_DISPLAY_DELAY_MS,
  );
  const duration = useToolDuration(
    durationStartedAt ?? block.createdAt,
    durationEndAt ?? block.completedAt,
    isRunning,
  );
  const hasDetail = block.type === "tool" && hasBlockDetail(block);
  const expanded = hasDetail && (forceExpanded || userExpanded);

  const toggleDetail = () => {
    reportReaderDisclosure();
    setUserExpanded((value) => !value);
  };

  if (block.type === "thinking") {
    return null;
  }
  if (block.type === "text") {
    return (
      <ProcessTextBlockItem
        block={block}
        isRunning={isRunning}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    );
  }
  if (block.type === "plan") {
    return (
      <PlanBlockItem block={block} onOpenAssistantPlan={onOpenAssistantPlan} />
    );
  }
  if (block.type === "file_changes") {
    return (
      <ProcessFileChangesBlockItem
        block={block}
        fileEditDurations={fileEditDurations}
        disclosureScope={disclosureScope}
      />
    );
  }

  if (block.toolName === "runtime_reconnecting") {
    if (!showReconnectingStatus) return null;
    const isChatGPTModel = block.toolInput?.model_kind === "codex-official";
    if (isChatGPTModel) {
      return (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 py-1 text-sm text-text-muted"
          data-testid="runtime-reconnecting-chatgpt-status"
          role="status"
        >
          <span>{t("tool_activity.chatgpt_network_unavailable")}</span>
          <button
            type="button"
            data-testid="runtime-reconnecting-open-proxy-settings"
            onClick={interactions.openProxySettings}
            disabled={!interactions.openProxySettings}
            className="font-medium text-blue-600 hover:underline dark:text-blue-300"
          >
            {t("tool_activity.open_proxy_settings")}
          </button>
        </div>
      );
    }
    return (
      <div
        className="min-w-0 truncate py-1 text-sm text-text-muted"
        data-testid="runtime-reconnecting-status"
        role="status"
      >
        <ActivityShimmerText variant="tool">
          {t("tool_activity.reconnecting")}
        </ActivityShimmerText>
      </div>
    );
  }

  const { icon, label } = getBlockLabel(block, {
    waitRunning: t("tool_activity.wait_running"),
    waitDone: t("tool_activity.wait_done"),
    waitError: t("tool_activity.wait_error"),
    callRunning: (name) => t("tool_activity.call_running", { name }),
    callDone: (name) => t("tool_activity.call_done", { name }),
    callError: (name) => t("tool_activity.call_error", { name }),
    fileCount: (count) => t("tool_activity.file_count", { count }),
    fileFallback: t("tool_activity.file_fallback"),
    searchRunning: t("tool_activity.search_running"),
    searchDone: t("tool_activity.search_done"),
    searchError: t("tool_activity.search_error"),
    imageView: (filename) => t("tool_activity.image_view", { filename }),
    imageViewFallback: t("tool_activity.image_view_fallback"),
    imageGenerationRunning: t("tool_activity.image_generation_running"),
    imageGenerationDone: t("tool_activity.image_generation_done"),
    imageGenerationError: t("tool_activity.image_generation_error"),
    javascriptRunning: t("tool_activity.javascript_running"),
    javascriptDone: t("tool_activity.javascript_done"),
    javascriptError: t("tool_activity.javascript_error"),
  });
  const workspaceFilePath = getWorkspaceFilePath(block);
  const labelContent = (
    <>
      {icon}
      {isRunning ? (
        <ActivityShimmerText variant="tool" className="min-w-0 truncate">
          {label}
        </ActivityShimmerText>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      {isRunning && (
        <span className="animate-pulse text-xs will-change-opacity">...</span>
      )}
    </>
  );

  return (
    <div
      className="min-w-0 overflow-x-clip text-sm"
      data-processing-block-id={block.id}
    >
      <div
        className={`flex w-full max-w-full items-center gap-1.5 text-text-secondary ${compact ? "min-h-8" : ""}`}
      >
        {workspaceFilePath && onOpenWorkspaceFile ? (
          <button
            type="button"
            onClick={() => {
              onOpenWorkspaceFile(workspaceFilePath);
              interactions.onOutputAction?.("open_file");
            }}
            className="flex min-w-0 items-center gap-1.5 hover:text-text-primary"
          >
            {labelContent}
          </button>
        ) : hasDetail ? (
          <button
            type="button"
            data-tool-detail-toggle
            aria-expanded={expanded}
            onClick={toggleDetail}
            className="flex min-w-0 items-center gap-1.5 hover:text-text-primary"
          >
            {labelContent}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            {labelContent}
          </span>
        )}
        {hasDetail ? (
          <button
            type="button"
            data-tool-detail-toggle
            onClick={toggleDetail}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={expanded ? "收起工具详情" : "展开工具详情"}
            aria-expanded={expanded}
          >
            <svg
              className={`h-3 w-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        ) : null}
        <span
          className="ml-auto shrink-0 pl-2 font-mono text-xs text-text-muted"
          data-testid="tool-block-duration"
        >
          {duration}
        </span>
      </div>
      {expanded ? (
        <div className="mt-2 min-w-0 overflow-x-clip">
          {renderBlockDetail(block)}
        </div>
      ) : null}
    </div>
  );
}

function PlanBlockItem({
  block,
  onOpenAssistantPlan,
}: {
  block: Extract<ProcessingBlock, { type: "plan" }>;
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void;
}) {
  if (!block.content.trim()) return null;

  const isStreaming = block.status !== "done" && block.status !== "error";
  const openPlan = onOpenAssistantPlan
    ? () => {
        onOpenAssistantPlan({
          blockId: block.id,
          subtaskId: String(block.subtaskId),
          content: block.content,
        });
      }
    : undefined;

  return (
    <div data-processing-block-id={block.id}>
      <AssistantPlanCard
        content={block.content}
        isStreaming={isStreaming}
        onOpenPlan={openPlan}
      />
    </div>
  );
}

function useDelayedBlockVisibility(
  blockId: string | null,
  delayMs: number,
): boolean {
  const [visibleBlockId, setVisibleBlockId] = useState<string | null>(null);

  useEffect(() => {
    if (!blockId) return;
    const timer = window.setTimeout(() => setVisibleBlockId(blockId), delayMs);
    return () => {
      window.clearTimeout(timer);
      setVisibleBlockId(null);
    };
  }, [blockId, delayMs]);

  return blockId !== null && visibleBlockId === blockId;
}

function ProcessTextBlockItem({
  block,
  isRunning,
  onOpenWorkspaceFile,
}: {
  block: Extract<ProcessingBlock, { type: "text" }>;
  isRunning: boolean;
  onOpenWorkspaceFile?: (
    path: string,
    options?: WorkspaceFileOpenOptions,
  ) => void;
}) {
  const { t } = useConversationTranslation();

  if (!block.content) return null;

  return (
    <div
      className="min-w-0 overflow-x-hidden text-chat text-text-primary"
      data-processing-block-id={block.id}
      data-message-selectable-text
      role={isRunning ? "status" : undefined}
      aria-live={isRunning ? "polite" : undefined}
      aria-label={isRunning ? t("process_text.running") : undefined}
      data-testid="process-text-block"
    >
      <div className="min-w-0">
        <AssistantMarkdown
          content={block.content}
          isStreaming={isRunning}
          variant="process"
          onOpenFile={onOpenWorkspaceFile}
        />
      </div>
    </div>
  );
}
