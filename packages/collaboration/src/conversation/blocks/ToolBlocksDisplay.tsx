import { useEffect, useMemo, useState } from 'react'
import { useConversationTranslation } from '../ConversationTranslation'
import type { RequestUserInputResponse } from '@wegent/chat-core/runtime'
import type { ProcessingBlock, SubagentBlock } from './types'
import {
  isAnsweredRequestUserInputBlock,
  isHiddenRequestUserInputBlock,
  isRequestUserInputBlock,
} from '@wegent/chat-core/runtime-user-input'
import { ToolBlockItem } from './ToolBlockItem'
import type { FileEditDurationsByBlock } from './ToolFileChanges'
import {
  RequestUserInputCard,
  RequestUserInputSummary,
  type RequestUserInputPayload,
} from '../RequestUserInputCard'
import type { AssistantPlanOpenRequest } from '../AssistantPlanCard'
import {
  buildProcessingDisplayRows,
  isContextCompactionToolBlock,
  type ProcessingDisplayRow,
} from './toolBlockActivity'
import {
  collapsePersistentProcessingExpansions,
  getProcessingDetailStateKey,
  useAnyPersistentProcessingExpansion,
  usePersistentProcessingExpansion,
} from './processingExpansionState'
import { getDurationText } from './processingDuration'
import { getFileEditDurationsBySourceBlock, getFileEditDurationsForRows } from './fileEditDurations'
import { SubagentActivityGroup } from './SubagentBlockItem'
import { type ProcessingDisplayItem } from './processingDisplayTypes'
import {
  ProcessingSummaryHeader,
  LiveProcessingPreview,
  CollapsibleProcessingContent,
} from './ProcessingPreview'
import {
  countProcessingActivityKinds,
  countProcessingToolCalls,
  ToolActivityGroup,
  ContextCompactionIndicator,
} from './ProcessingActivity'

/**
 * What a turn's process section occupies while it is collapsed, which is how a finished turn renders:
 * the summary row's `min-h-8` (32px) plus the section's own `mb-3` (12px). `messagePretextLayout` keeps
 * its intrinsic-height estimate in step with this, so the height a row is laid out at before it is
 * measured does not depend on how many blocks the turn happened to run.
 */
export const COLLAPSED_PROCESSING_HEIGHT = 44

const EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS = new Set<string>()

interface ToolBlocksDisplayProps {
  blocks: ProcessingBlock[]
  fileEditDurationsBySourceBlock?: FileEditDurationsByBlock
  isStreaming: boolean
  // Wall-clock epoch ms when the turn started (the assistant turn's
  // created_at). Used as the duration anchor so the elapsed time survives a
  // page refresh: after a refresh the in-progress blocks are re-streamed with
  // fresh client timestamps, so anchoring to the first block would restart the
  // timer from the refresh moment.
  startedAt?: number
  forceExpanded?: boolean
  processingPhase?: 'live' | 'intermediate' | 'final'
  showInterToolThinking?: boolean
  thinkingContent?: string
  showSummary?: boolean
  stateKey?: string
  detailStateScopeKey?: string
  onOpenWorkspaceFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  onOpenSubagent?: (block: SubagentBlock) => void
}

export function ToolBlocksDisplay({
  blocks,
  fileEditDurationsBySourceBlock,
  isStreaming,
  startedAt,
  forceExpanded = false,
  processingPhase = 'live',
  showInterToolThinking = false,
  thinkingContent = '',
  showSummary = true,
  stateKey,
  detailStateScopeKey,
  onOpenWorkspaceFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  hideRequestUserInputBlocks = false,
  hiddenRequestUserInputIds,
  onOpenSubagent,
}: ToolBlocksDisplayProps) {
  const { t } = useConversationTranslation()
  const hasRunningBlock = blocks.some(b => b.status !== 'done' && b.status !== 'error')
  const isRunning =
    (isStreaming && (processingPhase === 'live' || showInterToolThinking)) || hasRunningBlock
  const [userExpanded, setUserExpanded] = usePersistentProcessingExpansion(
    stateKey ? `${stateKey}:processing` : undefined
  )
  const [livePreviewCollapsed, setLivePreviewCollapsed] = useState(false)
  const [hasLocallyExpandedPreviewDetail, setHasLocallyExpandedPreviewDetail] =
    useState(false)
  const [mountedAt] = useState(() => Date.now())
  const turnStartedAt = startedAt ?? mountedAt
  const [hasRenderedRunning, setHasRenderedRunning] = useState(isRunning)
  const [completedAt, setCompletedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [isRunning])

  useEffect(() => {
    if (isRunning) {
      if (hasRenderedRunning && completedAt === null) return
      const timer = window.setTimeout(() => {
        setHasRenderedRunning(true)
        setCompletedAt(null)
      }, 0)
      return () => window.clearTimeout(timer)
    }

    if (hasRenderedRunning && completedAt === null) {
      const timer = window.setTimeout(() => setCompletedAt(Date.now()), 0)
      return () => window.clearTimeout(timer)
    }
  }, [completedAt, hasRenderedRunning, isRunning])

  const duration = getDurationText(blocks, turnStartedAt, now, completedAt, isRunning)
  const displayItems = useMemo(() => {
    const hiddenIds = hiddenRequestUserInputIds ?? EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS
    const items: ProcessingDisplayItem[] = []
    let pendingRegularBlocks: ProcessingBlock[] = []

    const flushRegularBlocks = () => {
      if (pendingRegularBlocks.length === 0) return
      const rows = buildProcessingDisplayRows(pendingRegularBlocks, {
        groupCompletedTools: false,
      })
      let pendingSubagents: SubagentBlock[] = []
      const flushSubagents = () => {
        if (pendingSubagents.length === 0) return
        items.push({
          type: 'subagent_group',
          id: `subagents:${pendingSubagents.map(block => block.id).join(':')}`,
          blocks: pendingSubagents,
        })
        pendingSubagents = []
      }

      rows.forEach(row => {
        if (row.type === 'block' && row.block.type === 'subagent') {
          pendingSubagents.push(row.block)
          return
        }
        flushSubagents()
        items.push(row)
      })
      flushSubagents()
      pendingRegularBlocks = []
    }

    blocks.forEach(block => {
      if (!isRequestUserInputBlock(block)) {
        pendingRegularBlocks.push(block)
        return
      }

      const isUnansweredRequest =
        block.status !== 'error' && !isAnsweredRequestUserInputBlock(block)
      const shouldHidePendingRequest =
        isUnansweredRequest &&
        (hideRequestUserInputBlocks || isHiddenRequestUserInputBlock(block, hiddenIds))
      if (shouldHidePendingRequest) return

      flushRegularBlocks()
      items.push({
        type: 'request_user_input',
        id: block.id,
        block,
      })
    })

    flushRegularBlocks()
    return items
  }, [blocks, hiddenRequestUserInputIds, hideRequestUserInputBlocks])
  const rows = useMemo(
    () =>
      displayItems.filter(
        (item): item is ProcessingDisplayRow =>
          item.type !== 'request_user_input' && item.type !== 'subagent_group'
      ),
    [displayItems]
  )
  const effectiveDetailStateScopeKey = detailStateScopeKey ?? stateKey
  const previewDetailStateKeys = useMemo(
    () =>
      effectiveDetailStateScopeKey
        ? rows.map(row => getProcessingDetailStateKey(effectiveDetailStateScopeKey, row.id))
        : [],
    [effectiveDetailStateScopeKey, rows]
  )
  const hasExpandedPreviewDetail =
    useAnyPersistentProcessingExpansion(previewDetailStateKeys) ||
    hasLocallyExpandedPreviewDetail
  const hasSubagentActivity = displayItems.some(item => item.type === 'subagent_group')
  const sourceFileEditDurations = useMemo(
    () => fileEditDurationsBySourceBlock ?? getFileEditDurationsBySourceBlock(blocks),
    [blocks, fileEditDurationsBySourceBlock]
  )
  const fileEditDurations = useMemo(
    () => getFileEditDurationsForRows(sourceFileEditDurations, rows),
    [rows, sourceFileEditDurations]
  )
  const hasPlanResponse = blocks.some(block => block.type === 'plan' && block.content.trim())
  const hasRequestUserInput = displayItems.some(item => item.type === 'request_user_input')
  const hasActiveContextCompaction = blocks.some(
    block =>
      isContextCompactionToolBlock(block) && block.status !== 'done' && block.status !== 'error'
  )
  const isLockedOpen =
    forceExpanded ||
    !showSummary ||
    hasSubagentActivity ||
    hasPlanResponse ||
    hasRequestUserInput ||
    hasActiveContextCompaction
  const hasRunningToolActivity = rows.some(row =>
    row.type === 'activity_group'
      ? row.blocks.some(block => block.status !== 'done' && block.status !== 'error')
      : (row.block.type === 'tool' || row.block.type === 'file_changes') &&
        row.block.status !== 'done' &&
        row.block.status !== 'error'
  )
  const hasClosedToolSegment = processingPhase !== 'live'
  const usesUnifiedToolList = showSummary && !isLockedOpen
  const expanded = isLockedOpen || (userExpanded && !usesUnifiedToolList)
  const canToggleSummary =
    showSummary && !isLockedOpen && !hasRunningToolActivity && rows.length > 0
  const hasLivePreview =
    isRunning &&
    (!hasClosedToolSegment || hasRunningToolActivity || showInterToolThinking) &&
    !expanded &&
    rows.length > 0
  const previewRows = useMemo(
    () =>
      !expanded &&
      (hasRunningToolActivity ||
        (hasLivePreview && !livePreviewCollapsed) ||
        hasExpandedPreviewDetail ||
        (usesUnifiedToolList && userExpanded))
        ? rows
        : [],
    [
      expanded,
      hasExpandedPreviewDetail,
      hasLivePreview,
      hasRunningToolActivity,
      livePreviewCollapsed,
      rows,
      userExpanded,
      usesUnifiedToolList,
    ]
  )
  const summaryExpanded = expanded || previewRows.length > 0
  const toggleSummary = () => {
    if (hasLivePreview) {
      if (!livePreviewCollapsed) {
        setHasLocallyExpandedPreviewDetail(false)
        collapsePersistentProcessingExpansions(previewDetailStateKeys)
      }
      setLivePreviewCollapsed(value => !value)
      return
    }
    if (summaryExpanded) {
      setHasLocallyExpandedPreviewDetail(false)
      collapsePersistentProcessingExpansions(previewDetailStateKeys)
      setUserExpanded(false)
      return
    }
    setUserExpanded(true)
  }
  const hasToolActivity = rows.some(
    row =>
      row.type === 'activity_group' ||
      row.block.type === 'tool' ||
      row.block.type === 'file_changes'
  )
  const activityStats = countProcessingActivityKinds(rows)
  const hasOnlyEditActivity =
    activityStats.edit > 0 &&
    activityStats.command === 0 &&
    activityStats.file === 0 &&
    activityStats.search === 0 &&
    activityStats.other === 0
  const toolCallCount = countProcessingToolCalls(activityStats)
  const summaryTitle = hasToolActivity
    ? hasOnlyEditActivity
      ? t('tool_activity.edit_summary', { count: activityStats.edit })
      : activityStats.edit > 0
        ? t('tool_activity.mixed_summary', {
            count: activityStats.edit,
            toolSummary: t('tool_activity.summary', { count: toolCallCount }),
          })
        : t('tool_activity.summary', { count: toolCallCount })
    : t('thinking.completed')
  const summaryDuration = hasToolActivity ? '' : duration.replace(/^已处理\s*/, '')
  const processingContent = useMemo(
    () =>
      expanded ? (
        <div className="flex min-w-0 flex-col gap-3 pt-0.5">
          {displayItems.map(item => {
            if (item.type === 'request_user_input') {
              return isAnsweredRequestUserInputBlock(item.block) ? (
                <RequestUserInputSummary key={item.id} payload={item.block.renderPayload} />
              ) : (
                <RequestUserInputCard
                  key={item.id}
                  payload={item.block.renderPayload}
                  disabled={item.block.status === 'error'}
                  onSubmit={onRequestUserInputSubmit}
                  onIgnore={
                    onRequestUserInputIgnore
                      ? () => onRequestUserInputIgnore(item.block.renderPayload)
                      : undefined
                  }
                />
              )
            }

            return item.type === 'subagent_group' ? (
              <SubagentActivityGroup
                key={item.id}
                blocks={item.blocks}
                onOpenSubagent={onOpenSubagent}
              />
            ) : item.type === 'activity_group' ? (
              <ToolActivityGroup
                key={item.id}
                row={item}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            ) : item.block.type === 'subagent' ? (
              <SubagentActivityGroup
                key={item.id}
                blocks={[item.block]}
                onOpenSubagent={onOpenSubagent}
              />
            ) : isContextCompactionToolBlock(item.block) ? (
              <ContextCompactionIndicator key={item.id} block={item.block} />
            ) : (
              <ToolBlockItem
                key={item.id}
                block={item.block}
                stateKey={
                  effectiveDetailStateScopeKey
                    ? getProcessingDetailStateKey(effectiveDetailStateScopeKey, item.id)
                    : undefined
                }
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                onOpenAssistantPlan={onOpenAssistantPlan}
                fileEditDurations={fileEditDurations}
              />
            )
          })}
        </div>
      ) : null,
    [
      displayItems,
      expanded,
      onOpenWorkspaceFile,
      onOpenAssistantPlan,
      fileEditDurations,
      onRequestUserInputIgnore,
      onRequestUserInputSubmit,
      effectiveDetailStateScopeKey,
      onOpenSubagent,
    ]
  )

  if (blocks.length === 0 && !isStreaming) return null

  const processingBody = (
    <>
      {showSummary ? (
        <ProcessingSummaryHeader
          canToggle={canToggleSummary}
          duration={summaryDuration}
          expanded={summaryExpanded}
          isRunning={isRunning && !hasClosedToolSegment}
          rows={rows}
          onToggle={toggleSummary}
          title={summaryTitle}
          labels={{
            command: t('tool_activity.command'),
            file: t('tool_activity.file'),
            search: t('tool_activity.search'),
            edit: t('tool_activity.edit'),
            other: t('tool_activity.other'),
          }}
        />
      ) : null}
      <CollapsibleProcessingContent expanded={expanded}>
        {processingContent}
      </CollapsibleProcessingContent>
      {previewRows.length > 0 ? (
        <LiveProcessingPreview
          rows={previewRows}
          showThinking={
            isStreaming &&
            hasToolActivity &&
            !hasRunningToolActivity &&
            (processingPhase === 'live' || showInterToolThinking)
          }
          thinkingContent={thinkingContent}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          fileEditDurations={fileEditDurations}
          detailStateScopeKey={effectiveDetailStateScopeKey}
          onExpandedDetailChange={setHasLocallyExpandedPreviewDetail}
          onOpenSubagent={onOpenSubagent}
        />
      ) : null}
    </>
  )
  return <div className="mb-3 min-w-0 w-full">{processingBody}</div>
}
