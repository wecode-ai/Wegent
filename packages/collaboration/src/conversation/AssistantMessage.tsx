import { Fragment, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type {
  Attachment,
  RequestUserInputResponse,
  RequestUserInputPayload,
  TurnFileChangesSummary,
} from "@wegent/chat-core/runtime";
import type {
  WorkbenchMessage,
  SubagentBlock,
  RuntimeConversationTurn,
} from "@wegent/chat-core/runtime-conversation";
import { getRuntimeMessageActiveThinking } from "@wegent/chat-core/runtime-thinking";
import { stripPluginWorkspaceResultMarkers } from "@wegent/chat-core/plugin-workspace-result";
import {
  AssistantMarkdown,
  type AssistantMarkdownProps,
} from "../markdown/AssistantMarkdown";
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from "../markdown/MarkdownServices";
import type { AttachmentImageServices } from "../issue-detail/AttachmentImageView";
import { useConversationTranslation } from "./ConversationTranslation";
import { AssistantThinkingIndicator } from "./AssistantThinkingIndicator";
import { ToolBlocksDisplay } from "./blocks/ToolBlocksDisplay";
import { getFileEditDurationsBySourceBlock } from "./blocks/fileEditDurations";
import { ProcessingDurationLabel } from "./ProcessingDurationLabel";
import {
  collapsePersistentProcessingExpansions,
  useAnyPersistentProcessingExpansion,
  usePersistentProcessingExpansion,
} from "./blocks/processingExpansionState";
import { WebSearchSourcesChip } from "./blocks/WebSearchSources";
import { getWebSearchSourceItems } from "./blocks/webSearchActivity";
import { CodexMemoryCitations, CodexReferenceList } from "./CodexTurnArtifacts";
import { getAssistantReferences } from "./codexReferences";
import { FileChangesCard } from "./FileChangesCard";
import type { AssistantPlanOpenRequest } from "./AssistantPlanCard";
import { MessageHoverActions } from "./MessageHoverActions";
import { AssistantErrorCard } from "./AssistantErrorCard";
import {
  getGeneratedImages,
  GeneratedImageGallery,
} from "./GeneratedImageGallery";
import {
  getMessageTimestampMs,
  getStoppedElapsedDuration,
  getProcessingSummaryStartMs,
  isCancelledAssistantMessage,
  isCancelledPlaceholderContent,
  shouldHideFailedAssistantContent,
  getDisplayProcessingBlocks,
  getWebSearchToolBlocks,
  getMessageDisplayStateKey,
  hasRunningProcessingBlocks,
  getOrderedRuntimeDisplaySegments,
  getProcessingPhase,
  splitProcessingBlocks,
  hasProcessingDisplayBlock,
  hasTrailingCompletedProcessText,
  shouldShowAssistantThinkingIndicator,
} from "./assistantMessagePresentation";

export function AssistantMessage({
  imageServices,
  renderVisualization,
  message,
  runtimeTurn,
  conversationKey,
  isActiveTurn = false,
  devices,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  fileChangesDiffPreviewDisabledSubtaskId,
  onOpenWorkspaceFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onOpenSubagent,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onFork,
}: {
  imageServices: AttachmentImageServices<Attachment>;
  renderVisualization?: AssistantMarkdownProps["renderVisualization"];
  message: WorkbenchMessage;
  runtimeTurn?: RuntimeConversationTurn;
  conversationKey?: string | number | null;
  isActiveTurn?: boolean;
  devices: Array<{ device_id: string; status: string }>;
  onRetryFailedMessage?: (message: WorkbenchMessage) => void;
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void;
  onLoadFileChangesDiff?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary,
  ) => Promise<string>;
  onRevertFileChanges?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary,
  ) => Promise<TurnFileChangesSummary>;
  onOpenFileChangesReview?: (request: {
    subtaskId: string;
    loadDiff: () => Promise<string>;
    reviewTitle?: string;
    defaultFileTreeVisible?: boolean;
    focusFilePath?: string;
  }) => void;
  fileChangesDiffPreviewDisabledSubtaskId?: string | null;
  onOpenWorkspaceFile?: (
    path: string,
    options?: WorkspaceFileOpenOptions,
  ) => void;
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void;
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void;
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void;
  onOpenSubagent?: (block: SubagentBlock) => void;
  hideRequestUserInputBlocks?: boolean;
  hiddenRequestUserInputIds?: ReadonlySet<string>;
  onFork?: () => Promise<void> | void;
}) {
  const { t } = useConversationTranslation();
  const isCancelled = isCancelledAssistantMessage(message);
  const stoppedElapsedDuration =
    isCancelled && message.stoppedNotice !== false
      ? getStoppedElapsedDuration(message, runtimeTurn)
      : null;
  const shouldShowStoppedNotice =
    isCancelled && message.stoppedNotice !== false;
  const shouldHideContent =
    shouldHideFailedAssistantContent(message) ||
    (isCancelled && isCancelledPlaceholderContent(message.content));
  const visibleContent = shouldHideContent
    ? ""
    : stripPluginWorkspaceResultMarkers(message.content);
  const hiddenErrorContent =
    message.status === "failed" && shouldHideContent
      ? message.content.trim()
      : undefined;
  const displayBlocks = useMemo(
    () =>
      getDisplayProcessingBlocks(message.blocks, isCancelled, visibleContent),
    [isCancelled, message.blocks, visibleContent],
  );
  const fileEditDurationsBySourceBlock = useMemo(
    () => getFileEditDurationsBySourceBlock(displayBlocks),
    [displayBlocks],
  );
  const processingSegments = splitProcessingBlocks(displayBlocks);
  const hasBlocks = displayBlocks.length > 0;
  const hasProcessingActivity =
    hasBlocks || message.blocks?.some((block) => block.type === "thinking");
  const hasVisibleContent = Boolean(visibleContent.trim());
  const isStreaming = !isCancelled && message.status === "streaming";
  const activeThinkingContent = isStreaming
    ? getRuntimeMessageActiveThinking(message)
    : "";
  const hasRunningBlocks = hasRunningProcessingBlocks(displayBlocks);
  const isAssistantSettled =
    isCancelled || message.status === "done" || message.status === "failed";
  const isAssistantRunning =
    !isAssistantSettled && (isStreaming || hasRunningBlocks);
  const canShowFinalArtifacts = !isAssistantRunning;
  const shouldShowProcessingSummary = hasBlocks;
  const processingStateKey = getMessageDisplayStateKey(
    conversationKey,
    message,
  );
  const [finalProcessingExpanded, setFinalProcessingExpanded] =
    usePersistentProcessingExpansion(`${processingStateKey}:final-processing`);
  const isProcessingOnlyBeforeGuidance =
    Boolean(message.runtimeGuidanceSplitBefore) && !hasVisibleContent;
  const hasPlanResponse = displayBlocks.some(
    (block) => block.type === "plan" && Boolean(block.content.trim()),
  );
  const orderedRuntimeSegments = getOrderedRuntimeDisplaySegments(
    message.runtimeDisplayItems,
    displayBlocks,
  );
  const orderedRuntimeContent = orderedRuntimeSegments
    .flatMap((segment) => (segment.kind === "content" ? [segment.content] : []))
    .join("\n\n");
  const hasProcessingAfterContent = orderedRuntimeSegments.some(
    (segment, index) =>
      hasVisibleContent &&
      orderedRuntimeContent === visibleContent &&
      segment.kind === "content" &&
      orderedRuntimeSegments
        .slice(index + 1)
        .some((candidate) => candidate.kind === "processing"),
  );
  const expandedToolDetailStateKeys = hasProcessingAfterContent
    ? orderedRuntimeSegments.flatMap((segment, segmentIndex) =>
        segment.kind === "processing"
          ? splitProcessingBlocks(segment.blocks).flatMap(
              (processingSegment, processingIndex) =>
                processingSegment.blocks.map(
                  (block) =>
                    `${processingStateKey}:ordered:${segmentIndex}:${processingIndex}:${block.id}`,
                ),
            )
          : [],
      )
    : processingSegments.flatMap((segment, index) =>
        segment.blocks.map(
          (block) => `${processingStateKey}:${index}:${block.id}`,
        ),
      );
  const hasExpandedToolDetail = useAnyPersistentProcessingExpansion(
    expandedToolDetailStateKeys,
  );
  const usesFinalProcessingShell =
    hasBlocks &&
    !isAssistantRunning &&
    !isActiveTurn &&
    !hasPlanResponse &&
    !hasRunningBlocks &&
    !isCancelled &&
    !hasProcessingAfterContent &&
    ((isProcessingOnlyBeforeGuidance && !isActiveTurn) ||
      (hasVisibleContent &&
        !message.runtimeGuidanceSplitBefore &&
        !message.runtimeGuidanceContinuation));
  const isFinalProcessingExpanded =
    finalProcessingExpanded || hasExpandedToolDetail;
  const toggleFinalProcessing = () => {
    if (isFinalProcessingExpanded) {
      setFinalProcessingExpanded(false);
      collapsePersistentProcessingExpansions(expandedToolDetailStateKeys);
      return;
    }
    setFinalProcessingExpanded(true);
  };
  const shouldShowThinking = shouldShowAssistantThinkingIndicator({
    isStreaming,
    hasProcessingDisplayBlock: hasProcessingDisplayBlock(displayBlocks),
    hasVisibleContent,
    hasTrailingCompletedProcessText:
      hasTrailingCompletedProcessText(displayBlocks),
  });
  const webSearchSources = isStreaming
    ? []
    : getWebSearchSourceItems(getWebSearchToolBlocks(displayBlocks));
  const memoryCitations = message.memoryCitations ?? [];
  const generatedImages = useMemo(
    () =>
      getGeneratedImages(
        displayBlocks,
        t("tool_activity.image_generation_alt"),
      ),
    [displayBlocks, t],
  );
  const [areHoverActionsVisible, setAreHoverActionsVisible] = useState(false);

  const openFileFromLink = onOpenWorkspaceFile
    ? (path: string, options?: WorkspaceFileOpenOptions) => {
        if (options) {
          onOpenWorkspaceFile(path, options);
          return;
        }
        onOpenWorkspaceFile(path);
      }
    : undefined;
  const references = getAssistantReferences(
    message.references,
    visibleContent,
    message.fileChanges,
  );
  const processingTimeline = shouldShowProcessingSummary
    ? processingSegments.map((segment, index) => (
        <ToolBlocksDisplay
          key={`${segment.kind}:${index}`}
          blocks={segment.blocks}
          fileEditDurationsBySourceBlock={fileEditDurationsBySourceBlock}
          isStreaming={isStreaming}
          startedAt={getProcessingSummaryStartMs(
            message,
            segment.blocks,
            isStreaming,
          )}
          forceExpanded={segment.kind === "narrative"}
          processingPhase={
            segment.blocks.length === 0
              ? "live"
              : usesFinalProcessingShell
                ? "intermediate"
                : getProcessingPhase(
                    processingSegments,
                    index,
                    hasVisibleContent,
                  )
          }
          showInterToolThinking={
            isStreaming &&
            !hasVisibleContent &&
            segment.kind === "tool" &&
            !processingSegments
              .slice(index + 1)
              .some((candidate) => candidate.kind === "tool")
          }
          thinkingContent={activeThinkingContent}
          showSummary={segment.kind === "tool"}
          stateKey={`${processingStateKey}:${index}`}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onRequestUserInputSubmit={onRequestUserInputSubmit}
          onRequestUserInputIgnore={onRequestUserInputIgnore}
          onOpenAssistantPlan={onOpenAssistantPlan}
          onOpenSubagent={onOpenSubagent}
          hideRequestUserInputBlocks={hideRequestUserInputBlocks}
          hiddenRequestUserInputIds={hiddenRequestUserInputIds}
        />
      ))
    : null;
  const orderedRuntimeTimeline = hasProcessingAfterContent
    ? orderedRuntimeSegments.map((segment, segmentIndex) => {
        if (segment.kind === "content") {
          return (
            <div
              key={`content:${segmentIndex}`}
              data-message-selectable-text
              data-testid="assistant-message-content"
            >
              <AssistantMarkdown
                content={segment.content}
                isStreaming={isStreaming}
                onOpenFile={openFileFromLink}
                renderVisualization={renderVisualization}
              />
            </div>
          );
        }

        const segments = splitProcessingBlocks(segment.blocks);
        return (
          <Fragment key={`processing:${segmentIndex}`}>
            {segments.map((processingSegment, processingIndex) => (
              <ToolBlocksDisplay
                key={`${processingSegment.kind}:${processingIndex}`}
                blocks={processingSegment.blocks}
                fileEditDurationsBySourceBlock={fileEditDurationsBySourceBlock}
                isStreaming={isStreaming}
                startedAt={getProcessingSummaryStartMs(
                  message,
                  processingSegment.blocks,
                  isStreaming,
                )}
                forceExpanded={processingSegment.kind === "narrative"}
                processingPhase={
                  segmentIndex === orderedRuntimeSegments.length - 1
                    ? "live"
                    : "intermediate"
                }
                showInterToolThinking={
                  isStreaming &&
                  segmentIndex === orderedRuntimeSegments.length - 1 &&
                  processingSegment.kind === "tool" &&
                  processingIndex === segments.length - 1
                }
                thinkingContent={activeThinkingContent}
                showSummary={processingSegment.kind === "tool"}
                stateKey={`${processingStateKey}:ordered:${segmentIndex}:${processingIndex}`}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                onRequestUserInputSubmit={onRequestUserInputSubmit}
                onRequestUserInputIgnore={onRequestUserInputIgnore}
                onOpenAssistantPlan={onOpenAssistantPlan}
                onOpenSubagent={onOpenSubagent}
                hideRequestUserInputBlocks={hideRequestUserInputBlocks}
                hiddenRequestUserInputIds={hiddenRequestUserInputIds}
              />
            ))}
          </Fragment>
        );
      })
    : null;
  const lastProcessingBlock = displayBlocks.at(-1) ?? message.blocks?.at(-1);
  const processingStartedAt = runtimeTurn
    ? runtimeTurn.startedAt
    : getProcessingSummaryStartMs(message, message.blocks ?? [], false);
  const processingCompletedAt = runtimeTurn
    ? undefined
    : isAssistantRunning
      ? undefined
      : (getMessageTimestampMs(message.completedAt) ??
        lastProcessingBlock?.completedAt ??
        lastProcessingBlock?.createdAt);
  const processingDurationLabel =
    !isAssistantRunning &&
    runtimeTurn &&
    runtimeTurn.durationMs === undefined ? null : (
      <ProcessingDurationLabel
        startedAt={processingStartedAt}
        completedAt={processingCompletedAt}
        durationMs={isAssistantRunning ? undefined : runtimeTurn?.durationMs}
        isRunning={isAssistantRunning}
      />
    );

  return (
    <div className="min-w-0 max-w-full text-chat text-text-primary">
      <div
        className="w-full max-w-full"
        data-testid="message-hover-region"
        onPointerEnter={() => setAreHoverActionsVisible(true)}
        onPointerLeave={() => setAreHoverActionsVisible(false)}
      >
        <div className="w-full max-w-full">
          {shouldShowStoppedNotice ? (
            <div
              data-testid="assistant-stopped-notice"
              className="mb-3 w-full pb-1 text-xs text-text-muted"
            >
              {stoppedElapsedDuration
                ? t("assistant_status.stopped_after", {
                    duration: stoppedElapsedDuration,
                  })
                : t("assistant_status.stopped")}
            </div>
          ) : null}
          {hasProcessingActivity &&
          !isCancelled &&
          !usesFinalProcessingShell ? (
            <div
              className="mb-3 w-full border-b border-border pb-2 text-sm text-text-muted"
              data-testid="live-processing-timeline"
            >
              {processingDurationLabel}
            </div>
          ) : null}
          {usesFinalProcessingShell ? (
            <div
              className="mb-3 min-w-0 w-full border-b border-border pb-2"
              data-testid="final-processing-timeline"
            >
              <button
                type="button"
                data-testid="final-processing-toggle"
                aria-expanded={isFinalProcessingExpanded}
                className="flex min-h-8 items-center gap-1 text-sm text-text-muted hover:text-text-secondary"
                onClick={toggleFinalProcessing}
              >
                {processingDurationLabel}
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${isFinalProcessingExpanded ? "" : "-rotate-90"}`}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>
              {isFinalProcessingExpanded ? (
                <div className="mt-1">{processingTimeline}</div>
              ) : null}
            </div>
          ) : hasProcessingAfterContent ? (
            orderedRuntimeTimeline
          ) : (
            processingTimeline
          )}
          {shouldShowThinking && !hasVisibleContent && (
            <AssistantThinkingIndicator content={activeThinkingContent} />
          )}
          {generatedImages.length > 0 ? (
            <GeneratedImageGallery
              services={imageServices}
              images={generatedImages}
            />
          ) : null}
          {hasVisibleContent && !hasProcessingAfterContent ? (
            <div
              data-message-selectable-text
              data-testid="assistant-message-content"
            >
              <AssistantMarkdown
                content={visibleContent}
                isStreaming={isStreaming}
                onOpenFile={openFileFromLink}
                renderVisualization={renderVisualization}
              />
            </div>
          ) : null}
          {canShowFinalArtifacts &&
            hasVisibleContent &&
            webSearchSources.length > 0 && (
              <WebSearchSourcesChip sources={webSearchSources} />
            )}
          {canShowFinalArtifacts && memoryCitations.length > 0 && (
            <CodexMemoryCitations
              citations={memoryCitations}
              onOpenFile={onOpenWorkspaceFile}
            />
          )}
          {canShowFinalArtifacts &&
            references.length > 0 &&
            openFileFromLink && (
              <CodexReferenceList
                references={references}
                onOpenFile={openFileFromLink}
              />
            )}
          {message.status === "failed" && (
            <AssistantErrorCard
              error={message.error}
              errorType={message.errorType}
              rawError={hiddenErrorContent}
              message={message}
              onRetry={onRetryFailedMessage}
              onSwitchModel={onSwitchModelForFailedMessage}
            />
          )}
          {canShowFinalArtifacts &&
          message.fileChanges &&
          message.subtaskId &&
          onLoadFileChangesDiff &&
          onRevertFileChanges ? (
            <FileChangesCard
              subtaskId={message.subtaskId}
              summary={message.fileChanges}
              deviceOnline={devices.some(
                (device) =>
                  device.device_id === message.fileChanges?.device_id &&
                  device.status === "online",
              )}
              onLoadDiff={onLoadFileChangesDiff}
              onRevert={onRevertFileChanges}
              onOpenReview={onOpenFileChangesReview}
              diffPreviewDisabled={
                fileChangesDiffPreviewDisabledSubtaskId ===
                String(message.subtaskId)
              }
            />
          ) : null}
        </div>
        {message.status !== "streaming" &&
          !isCancelled &&
          (hasVisibleContent || message.status === "failed") && (
            <MessageHoverActions
              message={message}
              align="left"
              visible={areHoverActionsVisible}
              onFork={onFork}
            />
          )}
      </div>
    </div>
  );
}
