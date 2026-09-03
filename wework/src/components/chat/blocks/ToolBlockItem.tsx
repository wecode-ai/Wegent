import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronDown, Clock3, Copy, CopyCheck, FileDiff, Search, Wrench } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { terminalOutputToText } from '@/lib/terminal-text'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { track } from '@/telemetry/client'
import type { TurnFileChangeItem, TurnFileChangesSummary } from '@/types/api'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import { ActivityShimmerText } from '../ActivityShimmerText'
import { AssistantMarkdown } from '../AssistantMarkdown'
import { AssistantPlanCard, type AssistantPlanOpenRequest } from '../AssistantPlanCard'
import { localMarkdownImagePath, resolveDirectMarkdownImageSrc } from '../assistantMarkdownLinks'
import { parseUnifiedDiff } from '../parseUnifiedDiff'
import {
  getToolActivityFilePaths,
  getToolActivityKind,
  isWebSearchToolName,
} from './toolBlockActivity'
import {
  getFileInputPath,
  getFileInputPaths,
  getInputField,
  isCommandToolName,
  isFileCreateToolName,
  isFileEditToolName,
  isGuidanceToolName,
  isImageViewToolName,
  isFileReadToolName,
  isNodeReplToolName,
} from './toolBlockKinds'
import { WebSearchActivityRows } from './WebSearchSources'
import { getWebSearchActivityItems } from './webSearchActivity'
import { usePersistentProcessingExpansion } from './processingExpansionState'

const INLINE_DIFF_MAX_LINES = 96
const RECONNECTING_DISPLAY_DELAY_MS = 10_000

interface ToolBlockItemProps {
  block: ProcessingBlock
  compact?: boolean
  shimmer?: boolean
  durationStartedAt?: number
  durationEndAt?: number
  fileEditDurations?: FileEditDurationsByBlock
  forceExpanded?: boolean
  stateKey?: string
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
  onLoadFullTranscript?: () => Promise<void> | void
  loadingFullTranscript?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

export function ToolBlockItem({
  block,
  compact = false,
  shimmer = false,
  durationStartedAt,
  durationEndAt,
  fileEditDurations,
  forceExpanded = false,
  stateKey,
  onOpenWorkspaceFile,
  onOpenAssistantPlan,
  onLoadFullTranscript,
  loadingFullTranscript = false,
  onExpandedChange,
}: ToolBlockItemProps) {
  const { t } = useTranslation('chat')
  const [userExpanded, setUserExpanded] = usePersistentProcessingExpansion(stateKey)
  const isRunning = block.status !== 'done' && block.status !== 'error'
  const reconnectingBlockId =
    block.type === 'tool' && block.toolName === 'runtime_reconnecting' && isRunning
      ? block.id
      : null
  const showReconnectingStatus = useDelayedBlockVisibility(
    reconnectingBlockId,
    RECONNECTING_DISPLAY_DELAY_MS
  )
  const duration = useToolDuration(
    durationStartedAt ?? block.createdAt,
    durationEndAt ?? block.completedAt,
    isRunning
  )
  const hasDetail = block.type === 'tool' && hasBlockDetail(block)
  const expanded = hasDetail && (forceExpanded || userExpanded)

  useLayoutEffect(() => {
    if (block.type === 'tool') onExpandedChange?.(expanded)
  }, [block.type, expanded, onExpandedChange])

  if (block.type === 'thinking') {
    return null
  }
  if (block.type === 'text') {
    return (
      <ProcessTextBlockItem
        block={block}
        isRunning={isRunning}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    )
  }
  if (block.type === 'plan') {
    return <PlanBlockItem block={block} onOpenAssistantPlan={onOpenAssistantPlan} />
  }
  if (block.type === 'file_changes') {
    return (
      <ProcessFileChangesBlockItem
        block={block}
        shimmer={shimmer}
        fileEditDurations={fileEditDurations}
        onExpandedChange={onExpandedChange}
      />
    )
  }

  if (block.toolName === 'runtime_reconnecting') {
    if (!showReconnectingStatus) return null
    const isChatGPTModel = block.toolInput?.model_kind === 'codex-official'
    if (isChatGPTModel) {
      return (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 py-1 text-sm text-text-muted"
          data-testid="runtime-reconnecting-chatgpt-status"
          role="status"
        >
          <span>
            {t(
              'tool_activity.chatgpt_network_unavailable',
              '当前正在使用 ChatGPT 模型，网络连接不可用。是否设置代理？'
            )}
          </span>
          <button
            type="button"
            data-testid="runtime-reconnecting-open-proxy-settings"
            onClick={() => navigateTo('/settings/personal/proxy')}
            className="font-medium text-blue-600 hover:underline dark:text-blue-300"
          >
            {t('tool_activity.open_proxy_settings', '设置代理')}
          </button>
        </div>
      )
    }
    return (
      <div
        className="min-w-0 truncate py-1 text-sm text-text-muted"
        data-testid="runtime-reconnecting-status"
        role="status"
      >
        <ActivityShimmerText variant="tool">
          {t('tool_activity.reconnecting', '连接中断，正在重连…')}
        </ActivityShimmerText>
      </div>
    )
  }

  const { icon, label } = getBlockLabel(block, {
    waitRunning: t('tool_activity.wait_running'),
    waitDone: t('tool_activity.wait_done'),
    waitError: t('tool_activity.wait_error'),
    callRunning: name => t('tool_activity.call_running', { name }),
    callDone: name => t('tool_activity.call_done', { name }),
    callError: name => t('tool_activity.call_error', { name }),
    fileCount: count => t('tool_activity.file_count', { count }),
    fileFallback: t('tool_activity.file_fallback'),
    searchRunning: t('tool_activity.search_running'),
    searchDone: t('tool_activity.search_done'),
    searchError: t('tool_activity.search_error'),
    imageView: filename => t('tool_activity.image_view', { filename }),
    imageViewFallback: t('tool_activity.image_view_fallback'),
    javascriptRunning: t('tool_activity.javascript_running'),
    javascriptDone: t('tool_activity.javascript_done'),
    javascriptError: t('tool_activity.javascript_error'),
  })
  const workspaceFilePath = getWorkspaceFilePath(block)
  const labelContent = (
    <>
      {icon}
      {isRunning || shimmer ? (
        <ActivityShimmerText variant="tool" className="min-w-0 truncate">
          {label}
        </ActivityShimmerText>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      {isRunning && <span className="animate-pulse text-xs will-change-opacity">...</span>}
    </>
  )

  return (
    <div className="min-w-0 overflow-x-clip text-sm" data-processing-block-id={block.id}>
      <div
        className={`flex w-full max-w-full items-center gap-1.5 text-text-secondary ${compact ? 'min-h-8' : ''}`}
      >
        {workspaceFilePath && onOpenWorkspaceFile ? (
          <button
            type="button"
            onClick={() => {
              onOpenWorkspaceFile(workspaceFilePath)
              track('ai_output_action_completed', { action: 'open_file', source: 'chat' })
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
            onClick={() => setUserExpanded(value => !value)}
            className="flex min-w-0 items-center gap-1.5 hover:text-text-primary"
          >
            {labelContent}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">{labelContent}</span>
        )}
        {hasDetail ? (
          <button
            type="button"
            data-tool-detail-toggle
            onClick={() => setUserExpanded(value => !value)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={expanded ? '收起工具详情' : '展开工具详情'}
            aria-expanded={expanded}
          >
            <svg
              className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
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
          {renderBlockDetail(block, { onLoadFullTranscript, loadingFullTranscript })}
        </div>
      ) : null}
    </div>
  )
}

function PlanBlockItem({
  block,
  onOpenAssistantPlan,
}: {
  block: Extract<ProcessingBlock, { type: 'plan' }>
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
}) {
  if (!block.content.trim()) return null

  const isStreaming = block.status !== 'done' && block.status !== 'error'
  const openPlan = () => {
    onOpenAssistantPlan?.({
      blockId: block.id,
      subtaskId: String(block.subtaskId),
      content: block.content,
    })
  }

  return (
    <div data-processing-block-id={block.id}>
      <AssistantPlanCard content={block.content} isStreaming={isStreaming} onOpenPlan={openPlan} />
    </div>
  )
}

function ProcessFileChangesBlockItem({
  block,
  shimmer,
  fileEditDurations,
  onExpandedChange,
}: {
  block: Extract<ProcessingBlock, { type: 'file_changes' }>
  shimmer: boolean
  fileEditDurations?: FileEditDurationsByBlock
  onExpandedChange?: (expanded: boolean) => void
}) {
  const { t } = useTranslation('chat')
  const summary = block.fileChanges
  const isRunning = block.status !== 'done' && block.status !== 'error'
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null)

  useLayoutEffect(() => {
    onExpandedChange?.(expandedFilePath !== null)
  }, [expandedFilePath, onExpandedChange])

  if (!summary.files.length) return null

  return (
    <div
      className="min-w-0 overflow-visible text-sm"
      data-processing-block-id={block.id}
      data-testid="process-file-changes-block"
    >
      <div className="flex min-w-0 flex-col">
        {summary.files.map(file => {
          const previewLines = fileDiffPreviewLines(file, summary)
          const fileExpanded = expandedFilePath === file.path && previewLines.length > 0
          const editDuration = fileEditDurations?.get(block.id)?.get(file.path)
          return (
            <div key={`${file.old_path ?? ''}:${file.path}`} className="min-w-0">
              <button
                type="button"
                disabled={previewLines.length === 0}
                aria-expanded={previewLines.length > 0 ? fileExpanded : undefined}
                onClick={() =>
                  setExpandedFilePath(current => (current === file.path ? null : file.path))
                }
                className="group relative z-10 flex min-h-8 w-full max-w-full items-center gap-1.5 text-text-secondary disabled:cursor-default"
              >
                <FileDiff className="h-4 w-4 shrink-0" strokeWidth={1.7} />
                {isRunning || shimmer ? (
                  <ActivityShimmerText variant="tool" className="min-w-0 truncate">
                    {fileChangeRowLabel(file, t, isRunning)}
                  </ActivityShimmerText>
                ) : (
                  <span className="min-w-0 truncate">{fileChangeRowLabel(file, t, isRunning)}</span>
                )}
                {!file.binary ? (
                  <FileChangeLineStats file={file} isRunning={isRunning} streamId={block.id} />
                ) : null}
                {previewLines.length > 0 ? (
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform group-hover:text-text-secondary ${
                      fileExpanded ? '' : '-rotate-90'
                    }`}
                    strokeWidth={2}
                  />
                ) : null}
                <FileEditDurationText
                  key={editDuration?.id ?? block.id}
                  duration={editDuration}
                  fallbackStartedAt={block.createdAt}
                  fallbackCompletedAt={block.completedAt}
                  isRunning={isRunning}
                />
              </button>
              {fileExpanded ? <InlineDiffPreview file={file} lines={previewLines} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export interface FileEditDuration {
  id: string
  startedAt: number
  completedAt?: number
}

export type FileEditDurationsByBlock = ReadonlyMap<string, ReadonlyMap<string, FileEditDuration>>

type FileChangeStatBlock = {
  id: string
  additions: number
  deletions: number
}

type FileChangeStatBlockStyle = CSSProperties & {
  '--file-change-stat-addition-height': string
  '--file-change-stat-deletion-height': string
  '--file-change-stat-blocks-width': string
  '--file-change-stat-x': string
  '--file-change-stat-alpha': string
}

function FileChangeLineStats({
  file,
  isRunning,
  streamId,
}: {
  file: TurnFileChangeItem
  isRunning: boolean
  streamId: string
}) {
  const [statBlocks, setStatBlocks] = useState<FileChangeStatBlock[]>([])
  const previousRef = useRef({
    streamId,
    additions: file.additions,
    deletions: file.deletions,
  })
  const visibleStatBlocks =
    isRunning && statBlocks.length > 0
      ? statBlocks
      : buildStaticFileChangeStatBlocks(file, streamId)

  useEffect(() => {
    const previous = previousRef.current
    if (previous.streamId !== streamId) {
      previousRef.current = {
        streamId,
        additions: file.additions,
        deletions: file.deletions,
      }
      setStatBlocks([])
      return
    }

    const addedDelta = Math.max(0, file.additions - previous.additions)
    const deletedDelta = Math.max(0, file.deletions - previous.deletions)
    previousRef.current = {
      streamId,
      additions: file.additions,
      deletions: file.deletions,
    }

    if (!isRunning || (addedDelta === 0 && deletedDelta === 0)) return

    const now = Date.now()
    setStatBlocks(current =>
      [
        ...current,
        {
          id: `${streamId}:${now}:${addedDelta}:${deletedDelta}`,
          additions: addedDelta,
          deletions: deletedDelta,
        },
      ].slice(-6)
    )
  }, [file.additions, file.deletions, isRunning, streamId])

  return (
    <span
      className="flex shrink-0 items-center gap-2 text-xs font-medium tabular-nums"
      data-testid="file-change-line-stats"
    >
      <span className="inline-flex items-center text-green-600">
        +
        <AnimatedChangeNumber
          key={`${streamId}:additions`}
          value={file.additions}
          deltaPrefix="+"
        />
      </span>
      <span className="inline-flex items-center text-red-500">
        -
        <AnimatedChangeNumber
          key={`${streamId}:deletions`}
          value={file.deletions}
          deltaPrefix="-"
        />
      </span>
      {visibleStatBlocks.length > 0 ? <FileChangeStatBlocks blocks={visibleStatBlocks} /> : null}
    </span>
  )
}

function buildStaticFileChangeStatBlocks(
  file: TurnFileChangeItem,
  streamId: string
): FileChangeStatBlock[] {
  if (file.additions === 0 && file.deletions === 0) return []
  return [
    {
      id: `${streamId}:${file.path}:${file.additions}:${file.deletions}`,
      additions: file.additions,
      deletions: file.deletions,
    },
  ]
}

function AnimatedChangeNumber({ value, deltaPrefix }: { value: number; deltaPrefix: '+' | '-' }) {
  const previousValueRef = useRef(value)
  const [delta, setDelta] = useState(0)
  const [animationId, setAnimationId] = useState(0)

  useEffect(() => {
    if (previousValueRef.current === value) return
    const deltaValue = Math.abs(value - previousValueRef.current)
    previousValueRef.current = value
    setDelta(0)
    const frame = requestAnimationFrame(() => {
      setDelta(deltaValue)
      setAnimationId(current => current + 1)
    })
    const timeout = window.setTimeout(() => setDelta(0), 560)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [value])

  return (
    <span className="file-change-delta-number">
      <span className="file-change-rolling-viewport">
        <span
          key={`${value}-${animationId}`}
          className={`file-change-rolling-value ${delta > 0 ? 'is-rolling' : ''}`}
        >
          {value}
        </span>
      </span>
      {delta > 0 ? (
        <span key={`${deltaPrefix}${delta}-${value}`} className="file-change-delta-badge">
          {deltaPrefix}
          {delta}
        </span>
      ) : null}
    </span>
  )
}

function FileChangeStatBlocks({ blocks }: { blocks: FileChangeStatBlock[] }) {
  const width = Math.max(6, (blocks.length - 1) * 7 + 6)

  return (
    <span
      className="file-change-stat-blocks"
      aria-hidden="true"
      style={{ '--file-change-stat-blocks-width': `${width}px` } as FileChangeStatBlockStyle}
    >
      {blocks.map((block, index) => {
        const age = blocks.length - index - 1
        const additionHeight = block.additions > 0 ? Math.min(10, 3 + block.additions * 1.6) : 0
        const deletionHeight = block.deletions > 0 ? Math.min(10, 3 + block.deletions * 1.6) : 0
        return (
          <span
            key={block.id}
            className="file-change-stat-block"
            style={
              {
                '--file-change-stat-addition-height': `${additionHeight}px`,
                '--file-change-stat-deletion-height': `${deletionHeight}px`,
                '--file-change-stat-x': `${index * 7}px`,
                '--file-change-stat-alpha': `${Math.max(0.28, 0.96 - age * 0.11)}`,
              } as FileChangeStatBlockStyle
            }
          >
            {block.additions > 0 ? <span className="file-change-stat-segment is-addition" /> : null}
            {block.deletions > 0 ? <span className="file-change-stat-segment is-deletion" /> : null}
          </span>
        )
      })}
    </span>
  )
}

function FileEditDurationText({
  duration,
  fallbackStartedAt,
  fallbackCompletedAt,
  isRunning,
}: {
  duration: FileEditDuration | undefined
  fallbackStartedAt: number
  fallbackCompletedAt: number | undefined
  isRunning: boolean
}) {
  const durationIsRunning = duration ? duration.completedAt === undefined : isRunning
  const text = useToolDuration(
    duration?.startedAt ?? fallbackStartedAt,
    duration?.completedAt ?? fallbackCompletedAt,
    durationIsRunning
  )

  return <span className="ml-auto shrink-0 pl-2 font-mono text-xs text-text-muted">{text}</span>
}

function useToolDuration(startedAt: number, fallbackEndAt: number | undefined, isRunning: boolean) {
  const [now, setNow] = useState(() => Date.now())
  const [anchoredStartedAt] = useState(startedAt)
  const wasRunning = useRef(isRunning)
  const [completedAt, setCompletedAt] = useState<number | null>(null)

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [isRunning])

  useEffect(() => {
    if (wasRunning.current && !isRunning) setCompletedAt(Date.now())
    wasRunning.current = isRunning
  }, [isRunning])

  const durationStartedAt = fallbackEndAt === undefined ? anchoredStartedAt : startedAt
  const endedAt = isRunning ? now : (fallbackEndAt ?? completedAt ?? anchoredStartedAt)
  if (!isRunning && completedAt === null && fallbackEndAt === undefined) return ''
  return `${(Math.max(0, endedAt - durationStartedAt) / 1000).toFixed(1)}s`
}

function useDelayedBlockVisibility(blockId: string | null, delayMs: number): boolean {
  const [visibleBlockId, setVisibleBlockId] = useState<string | null>(null)

  useEffect(() => {
    if (!blockId) return
    const timer = window.setTimeout(() => setVisibleBlockId(blockId), delayMs)
    return () => {
      window.clearTimeout(timer)
      setVisibleBlockId(null)
    }
  }, [blockId, delayMs])

  return blockId !== null && visibleBlockId === blockId
}

function fileChangeRowLabel(
  file: TurnFileChangeItem,
  t: ReturnType<typeof useTranslation>['t'],
  isRunning = false
): string {
  const filename = basename(file.path)
  if (isRunning) {
    if (file.change_type === 'created') return t('file_changes.creating_file', { filename })
    if (file.change_type === 'deleted') return t('file_changes.deleting_file', { filename })
    if (file.change_type === 'renamed') return t('file_changes.renaming_file', { filename })
    return t('file_changes.editing_file', { filename })
  }
  switch (file.change_type) {
    case 'created':
      return t('tool_activity.created_file', { filename })
    case 'deleted':
      return t('tool_activity.deleted_file', { filename })
    case 'renamed':
      return t('tool_activity.renamed_file', { filename })
    case 'modified':
    default:
      return t('tool_activity.edited_file', { filename })
  }
}

function InlineDiffPreview({
  file,
  lines,
}: {
  file: TurnFileChangeItem
  lines: DiffPreviewLine[]
}) {
  const { t } = useTranslation('chat')
  const previewRef = useLockedMessageContentVisibility()
  const [copied, setCopied] = useState(false)
  const copyResetTimerRef = useRef<number | null>(null)
  const isDisposedRef = useRef(false)
  const visibleLines = lines.slice(0, INLINE_DIFF_MAX_LINES)
  const truncated = lines.length > INLINE_DIFF_MAX_LINES
  const copyText = formatDiffPreviewCopyText(visibleLines, truncated)

  useEffect(() => {
    isDisposedRef.current = false
    return () => {
      isDisposedRef.current = true
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
        copyResetTimerRef.current = null
      }
    }
  }, [])

  const handleCopy = async () => {
    await copyCodeText(copyText)
    if (isDisposedRef.current) return
    track('ai_output_action_completed', { action: 'copy', source: 'chat' })
    setCopied(true)
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current)
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopied(false)
      copyResetTimerRef.current = null
    }, 1500)
  }

  return (
    <div
      ref={previewRef}
      className="mt-2 max-h-[16rem] min-w-0 select-text overflow-auto overscroll-contain rounded-lg border border-border bg-surface font-mono text-xs leading-[18px]"
      data-testid="process-file-change-diff"
      data-message-content-visibility-lock="true"
      onClick={event => event.stopPropagation()}
    >
      <div
        data-testid="process-file-change-diff-header"
        className="sticky top-0 z-10 flex h-8 items-center justify-between gap-2 border-b border-border bg-surface px-3 font-sans text-xs text-text-secondary"
      >
        <span
          data-testid="process-file-change-diff-header-content"
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <span className="min-w-0 truncate">{basename(file.path)}</span>
          <span
            data-testid="process-file-change-diff-stats"
            className="flex shrink-0 items-center gap-1.5 font-medium"
          >
            <span className="text-green-600">+{file.additions}</span>
            <span className="text-red-500">-{file.deletions}</span>
          </span>
        </span>
        <button
          type="button"
          data-testid="copy-process-file-change-diff-button"
          aria-label={t('file_changes.copy_code')}
          title={t('file_changes.copy_code')}
          onClick={event => {
            event.stopPropagation()
            void handleCopy()
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {copied ? (
            <CopyCheck
              className="h-3.5 w-3.5"
              strokeWidth={2}
              data-testid="process-file-change-diff-copy-success-icon"
            />
          ) : (
            <Copy
              className="h-3.5 w-3.5"
              strokeWidth={2}
              data-testid="process-file-change-diff-copy-icon"
            />
          )}
        </button>
      </div>
      <div className="py-1">
        {visibleLines.map(line => (
          <div
            key={line.key}
            className={[
              'grid min-w-max grid-cols-[3.25rem_max-content]',
              line.type === 'addition'
                ? 'border-l-4 border-green-500 bg-green-500/10'
                : line.type === 'deletion'
                  ? 'border-l-4 border-red-500 bg-red-500/10'
                  : line.type === 'separator'
                    ? 'border-l-4 border-transparent bg-muted/60'
                    : 'border-l-4 border-transparent',
            ].join(' ')}
          >
            <span
              className={[
                'select-none px-3 text-right',
                line.type === 'addition'
                  ? 'text-green-600'
                  : line.type === 'deletion'
                    ? 'text-red-500'
                    : 'text-text-muted',
              ].join(' ')}
            >
              {line.lineNumber ?? ''}
            </span>
            <span className="pr-4 whitespace-pre text-text-primary">{line.content || ' '}</span>
          </div>
        ))}
        {truncated ? <div className="px-3 py-1 text-xs text-text-muted">...</div> : null}
      </div>
    </div>
  )
}

function useLockedMessageContentVisibility() {
  const previewRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const article = previewRef.current?.closest<HTMLElement>('[data-message-id]')
    if (!article) return

    const previousContentVisibility = article.style.contentVisibility
    article.style.contentVisibility = 'visible'

    return () => {
      article.style.contentVisibility = previousContentVisibility
    }
  }, [])

  return previewRef
}

interface DiffPreviewLine {
  key: string
  type: 'addition' | 'deletion' | 'context' | 'separator'
  lineNumber?: number
  content: string
}

function formatDiffPreviewCopyText(lines: DiffPreviewLine[], truncated: boolean): string {
  const formatted = lines.map(line => {
    if (line.type === 'separator') return ''
    if (line.type === 'addition') return `+${line.content}`
    if (line.type === 'deletion') return `-${line.content}`
    return ` ${line.content}`
  })

  if (truncated) formatted.push('...')
  return formatted.join('\n')
}

async function copyCodeText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function fileDiffPreviewLines(
  file: TurnFileChangeItem,
  summary: TurnFileChangesSummary
): DiffPreviewLine[] {
  if (file.binary || !summary.diff?.trim()) return []
  const sectionLines = fileDiffLines(file, summary)
  return parseDiffPreviewLines(sectionLines, file.change_type)
}

function fileDiffLines(file: TurnFileChangeItem, summary: TurnFileChangesSummary): string[] {
  const diff = summary.diff?.trimEnd()
  if (!diff) return []

  const sections = parseUnifiedDiff(diff)
  if (sections.length === 0) {
    return summary.files.length === 1 ? diff.split('\n') : []
  }

  const section = sections.find(
    item =>
      pathsMatch(item.path, file.path) ||
      (file.old_path ? pathsMatch(item.oldPath, file.old_path) : false)
  )
  return section?.lines ?? []
}

function pathsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

function parseDiffPreviewLines(
  lines: string[],
  changeType: TurnFileChangeItem['change_type']
): DiffPreviewLine[] {
  const previewLines: DiffPreviewLine[] = []
  let oldLine: number | undefined
  let newLine: number | undefined
  let seenHunk = false

  lines.forEach((rawLine, index) => {
    if (
      rawLine.startsWith('diff --git') ||
      rawLine.startsWith('---') ||
      rawLine.startsWith('+++') ||
      rawLine.startsWith('index ')
    ) {
      return
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      if (seenHunk && previewLines.length > 0) {
        previewLines.push({
          key: `separator-${index}`,
          type: 'separator',
          content: '',
        })
      }
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      seenHunk = true
      return
    }

    if (!seenHunk && !rawLine.startsWith('+') && !rawLine.startsWith('-')) return

    const prefix = rawLine[0]
    if (prefix === '+') {
      previewLines.push({
        key: `addition-${index}`,
        type: diffPreviewLineType(prefix, changeType),
        lineNumber: newLine ?? oldLine,
        content: rawLine.slice(1),
      })
      if (newLine !== undefined) newLine += 1
      return
    }
    if (prefix === '-') {
      previewLines.push({
        key: `deletion-${index}`,
        type: diffPreviewLineType(prefix, changeType),
        lineNumber: oldLine ?? newLine,
        content: rawLine.slice(1),
      })
      if (oldLine !== undefined) oldLine += 1
      return
    }

    previewLines.push({
      key: `context-${index}`,
      type: 'context',
      lineNumber: newLine ?? oldLine,
      content: prefix === ' ' ? rawLine.slice(1) : rawLine,
    })
    if (oldLine !== undefined) oldLine += 1
    if (newLine !== undefined) newLine += 1
  })

  return previewLines
}

function diffPreviewLineType(
  prefix: '+' | '-',
  changeType: TurnFileChangeItem['change_type']
): DiffPreviewLine['type'] {
  // Runtime patches can be reversed, but the file summary remains the
  // authoritative semantic direction for whole-file creation and deletion.
  if (changeType === 'created') return 'addition'
  if (changeType === 'deleted') return 'deletion'
  return prefix === '+' ? 'addition' : 'deletion'
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function ProcessTextBlockItem({
  block,
  isRunning,
  onOpenWorkspaceFile,
}: {
  block: Extract<ProcessingBlock, { type: 'text' }>
  isRunning: boolean
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const { t } = useTranslation('chat')

  if (!block.content) return null

  return (
    <div
      className="min-w-0 overflow-x-hidden text-chat text-text-primary"
      data-processing-block-id={block.id}
      data-message-selectable-text
      role={isRunning ? 'status' : undefined}
      aria-live={isRunning ? 'polite' : undefined}
      aria-label={isRunning ? t('process_text.running') : undefined}
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
  )
}

type GenericToolLabels = {
  waitRunning: string
  waitDone: string
  waitError: string
  callRunning: (name: string) => string
  callDone: (name: string) => string
  callError: (name: string) => string
  fileCount: (count: number) => string
  fileFallback: string
  searchRunning: string
  searchDone: string
  searchError: string
  imageView: (filename: string) => string
  imageViewFallback: string
  javascriptRunning: string
  javascriptDone: string
  javascriptError: string
}

function getBlockLabel(
  block: ToolBlock,
  genericLabels: GenericToolLabels
): { icon: React.ReactNode; label: string } {
  const name = block.toolName.toLowerCase()
  const prefix = getToolStatusPrefix(block)

  if (isNodeReplToolName(name)) {
    const label =
      block.status === 'error'
        ? genericLabels.javascriptError
        : block.status === 'done'
          ? genericLabels.javascriptDone
          : genericLabels.javascriptRunning
    return { icon: <TerminalIcon />, label }
  }
  if (isCommandToolName(name)) {
    const activityKind = getToolActivityKind(block)
    if (activityKind === 'file') {
      const paths = getToolActivityFilePaths(block)
      const target =
        paths.length === 1
          ? basename(paths[0])
          : paths.length > 1
            ? genericLabels.fileCount(paths.length)
            : genericLabels.fileFallback
      return { icon: <FileIcon />, label: `${prefix.read} ${target}` }
    }
    if (activityKind === 'search') {
      const action =
        block.status === 'error'
          ? genericLabels.searchError
          : block.status === 'done'
            ? genericLabels.searchDone
            : genericLabels.searchRunning
      return {
        icon: <Search className="h-4 w-4" strokeWidth={1.7} />,
        label: action,
      }
    }
    const command = getInputField(block, 'command', 'cmd', 'commandLine')
    const shortCmd = command ? truncate(command.split('\n')[0], 40) : block.toolName
    return { icon: <TerminalIcon />, label: `${prefix.running} ${shortCmd}` }
  }
  if (isFileCreateToolName(name)) {
    return { icon: <FileIcon />, label: getFileToolLabel(prefix.create, block, '新增') }
  }
  if (isFileEditToolName(name)) {
    return { icon: <EditIcon />, label: getFileToolLabel(prefix.edit, block, '编辑') }
  }
  if (isFileReadToolName(name)) {
    return { icon: <FileIcon />, label: getFileToolLabel(prefix.read, block, '读取') }
  }
  if (isWebSearchToolName(name)) {
    return {
      icon: <Search className="h-4 w-4" strokeWidth={1.7} />,
      label: prefix.webSearch,
    }
  }
  if (isImageViewToolName(name)) {
    const path = getInputField(block, 'path', 'file_path', 'filePath')
    return {
      icon: <FileIcon />,
      label: path ? genericLabels.imageView(basename(path)) : genericLabels.imageViewFallback,
    }
  }
  if (isGuidanceToolName(name)) {
    return { icon: <ToolIcon />, label: prefix.guidance }
  }

  return getGenericToolLabel(block, genericLabels)
}

function getGenericToolLabel(
  block: ToolBlock,
  labels: GenericToolLabels
): { icon: React.ReactNode; label: string } {
  const name = getReadableToolName(block.toolName)
  const normalizedName = name.toLowerCase()

  if (normalizedName.includes('wait')) {
    const label =
      block.status === 'error'
        ? labels.waitError
        : block.status === 'done'
          ? labels.waitDone
          : labels.waitRunning
    return {
      icon: <Clock3 className="h-4 w-4" strokeWidth={1.7} />,
      label,
    }
  }

  const label =
    block.status === 'error'
      ? labels.callError(name)
      : block.status === 'done'
        ? labels.callDone(name)
        : labels.callRunning(name)
  return {
    icon: <Wrench className="h-4 w-4" strokeWidth={1.7} />,
    label,
  }
}

function getReadableToolName(toolName: string): string {
  const normalized = toolName.trim()
  const leaf = normalized.split(/\.|__/).filter(Boolean).at(-1) ?? normalized
  return leaf.replaceAll('_', ' ')
}

function getFileToolLabel(prefix: string, block: ToolBlock, action: string): string {
  const filePaths = getFileInputPaths(block)
  if (filePaths.length === 1) return `${prefix} ${basename(filePaths[0])}`
  if (filePaths.length > 1) return `${prefix} ${filePaths.length} 个文件`
  return fileToolFallbackLabel(block.status, action)
}

function fileToolFallbackLabel(status: ToolBlock['status'], action: string): string {
  if (status === 'error') return `${action}文件失败`
  if (status === 'done') return `${action}文件`
  return `正在${action}文件`
}

function getToolStatusPrefix(block: ToolBlock) {
  if (block.status === 'error') {
    return {
      running: '运行失败',
      create: '新增失败',
      edit: '编辑失败',
      read: '读取失败',
      webSearch: '搜索网页失败',
      guidance: '引导对话失败',
      generic: '执行失败',
    }
  }

  if (block.status === 'done') {
    return {
      running: '运行',
      create: '新增',
      edit: '编辑',
      read: '读取',
      webSearch: '搜索网页',
      guidance: '引导对话',
      generic: '执行',
    }
  }

  return {
    running: '正在运行',
    create: '正在新增',
    edit: '正在编辑',
    read: '正在读取',
    webSearch: '正在搜索网页',
    guidance: '正在引导对话',
    generic: '正在执行',
  }
}

function TerminalIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3M4.5 19.5h15a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5h-15A1.5 1.5 0 003 6v12a1.5 1.5 0 001.5 1.5z"
      />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
      />
    </svg>
  )
}

function ToolIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.42 15.17l-5.1 5.1a2.121 2.121 0 11-3-3l5.1-5.1m0 0L15.17 4.83a2.121 2.121 0 113 3l-7.75 7.34z"
      />
    </svg>
  )
}

function renderBlockDetail(
  block: ToolBlock,
  options: {
    onLoadFullTranscript?: () => Promise<void> | void
    loadingFullTranscript?: boolean
  }
) {
  const name = block.toolName.toLowerCase()

  if (isCommandToolName(name)) {
    return <BashBlockDetail block={block} {...options} />
  }
  if (isFileCreateToolName(name)) {
    return <FileWriteDetail block={block} />
  }
  if (isFileEditToolName(name)) {
    return <FileEditDetail block={block} />
  }
  if (isWebSearchToolName(name)) {
    return <WebSearchBlockDetail block={block} />
  }
  if (isImageViewToolName(name)) {
    return <ImageViewBlockDetail block={block} />
  }
  if (isGuidanceToolName(name)) {
    return null
  }

  return <GenericToolBlockDetail block={block} />
}

function hasBlockDetail(block: ToolBlock): boolean {
  const name = block.toolName.toLowerCase()
  if (isGuidanceToolName(name)) return false
  if (
    isCommandToolName(name) ||
    isFileCreateToolName(name) ||
    isFileEditToolName(name) ||
    isWebSearchToolName(name) ||
    isImageViewToolName(name)
  ) {
    return true
  }
  return block.toolInput !== undefined || block.toolOutput !== undefined
}

function GenericToolBlockDetail({ block }: { block: ToolBlock }) {
  const { t } = useTranslation('chat')
  const inputText = stringifyToolValue(block.toolInput)
  const outputText = stringifyToolValue(block.toolOutput)
  const isJavaScript = isNodeReplToolName(block.toolName)
  const code = isJavaScript ? getInputField(block, 'code', 'javascript', 'source') : undefined

  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="generic-tool-block-detail"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-mono text-xs text-text-secondary">
          {block.toolName}
        </span>
        {isJavaScript ? <span className="shrink-0 text-xs text-text-muted">JavaScript</span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3 p-3">
        {code ? (
          <ToolDetailSection
            label={t('tool_activity.tool_input')}
            content={code}
            testId="generic-tool-input"
          />
        ) : inputText ? (
          <ToolDetailSection
            label={t('tool_activity.tool_input')}
            content={inputText}
            testId="generic-tool-input"
          />
        ) : null}
        {outputText ? (
          <ToolDetailSection
            label={t('tool_activity.tool_output')}
            content={outputText}
            testId="generic-tool-output"
          />
        ) : block.status === 'done' ? (
          <p className="text-xs text-text-muted">{t('tool_activity.tool_no_output')}</p>
        ) : null}
      </div>
    </div>
  )
}

function ToolDetailSection({
  label,
  content,
  testId,
}: {
  label: string
  content: string
  testId: string
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 text-xs text-text-muted">{label}</div>
      <pre
        className="max-h-48 max-w-full overflow-auto rounded-md bg-code-bg px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-text-secondary"
        data-testid={testId}
      >
        {content}
      </pre>
    </section>
  )
}

function stringifyToolValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ImageViewBlockDetail({ block }: { block: ToolBlock }) {
  const { t } = useTranslation('chat')
  const source = getImageViewSource(block)
  const resolvedSource = useResolvedImageViewSource(source)

  if (!resolvedSource) return null

  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="image-view-block-detail"
    >
      <img
        src={resolvedSource}
        alt={t('tool_activity.image_preview_alt')}
        className="max-h-96 w-full object-contain"
        data-testid="image-view-preview"
      />
    </div>
  )
}

function useResolvedImageViewSource(source?: string): string | null {
  const electronLocalPath = useMemo(() => {
    if (!source || !isElectronRuntime()) return null
    return localMarkdownImagePath(source)
  }, [source])
  const [electronImage, setElectronImage] = useState<{
    path: string
    url: string
  } | null>(null)

  useEffect(() => {
    if (!electronLocalPath) return undefined

    let active = true
    let objectUrl: string | null = null
    void readElectronLocalFile(electronLocalPath)
      .then(bytes => {
        objectUrl = URL.createObjectURL(new Blob([bytes]))
        if (active) setElectronImage({ path: electronLocalPath, url: objectUrl })
        else URL.revokeObjectURL(objectUrl)
      })
      .catch(() => undefined)

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [electronLocalPath])

  if (electronLocalPath) {
    return electronImage?.path === electronLocalPath ? electronImage.url : null
  }
  return source ? resolveDirectMarkdownImageSrc(source) : null
}

function getImageViewSource(block: ToolBlock): string | undefined {
  const output = block.toolOutput
  if (typeof output === 'string' && isImageSource(output)) return output
  if (isRecord(output)) {
    const directSource = getStringField(output, 'image_url', 'imageUrl', 'url', 'path')
    if (directSource && isImageSource(directSource)) return directSource

    const nestedImageUrl = output.image_url
    if (isRecord(nestedImageUrl)) {
      const nestedSource = getStringField(nestedImageUrl, 'url')
      if (nestedSource && isImageSource(nestedSource)) return nestedSource
    }
  }

  return getInputField(block, 'path', 'file_path', 'filePath')
}

function isImageSource(value: string): boolean {
  const source = value.trim()
  return (
    source.startsWith('data:image/') ||
    source.startsWith('blob:') ||
    source.startsWith('file://') ||
    /^https?:\/\//i.test(source) ||
    /^asset:/i.test(source) ||
    source.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(source)
  )
}

function WebSearchBlockDetail({ block }: { block: ToolBlock }) {
  const items = getWebSearchActivityItems([block])

  if (items.length === 0) return null

  return (
    <div data-testid="web-search-block-detail">
      <WebSearchActivityRows items={items} />
    </div>
  )
}

function getWorkspaceFilePath(block: ToolBlock): string | undefined {
  const name = block.toolName.toLowerCase()
  if (!isFileReadToolName(name) && !isFileCreateToolName(name) && !isFileEditToolName(name)) {
    return undefined
  }
  return getFileInputPath(block)
}

function BashBlockDetail({
  block,
  onLoadFullTranscript,
  loadingFullTranscript = false,
}: {
  block: ToolBlock
  onLoadFullTranscript?: () => Promise<void> | void
  loadingFullTranscript?: boolean
}) {
  const command = getInputField(block, 'command', 'cmd', 'commandLine')
  const cwd = getInputField(block, 'cwd', 'workdir', 'workingDirectory')
  const output = block.toolOutput
  const rawOutputText = useMemo(
    () => (typeof output === 'string' ? output : output ? JSON.stringify(output, null, 2) : ''),
    [output]
  )
  const outputText = useMemo(() => terminalOutputToText(rawOutputText), [rawOutputText])
  const outputRef = useRef<HTMLPreElement>(null)
  const isDone = block.status === 'done'
  const isError = block.status === 'error'
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    const outputElement = outputRef.current
    if (outputElement) outputElement.scrollTop = outputElement.scrollHeight
  }, [outputText])

  const handleCopy = () => {
    void navigator.clipboard.writeText(command ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="min-w-0 overflow-x-hidden rounded-lg bg-code-bg px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-text-muted">Shell</span>
        <button
          type="button"
          onClick={handleCopy}
          className="p-0.5 text-text-muted hover:text-text-secondary"
        >
          {copied ? (
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      </div>
      {command && (
        <div className="overflow-x-auto font-mono text-xs leading-5 text-text-primary">
          <span className="text-text-muted">$ </span>
          {command}
        </div>
      )}
      {cwd && (
        <div className="mt-1 min-w-0 truncate font-mono text-xs text-text-muted" title={cwd}>
          cwd: {cwd}
        </div>
      )}
      {outputText && (
        <>
          {block.toolOutputTruncated ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-muted">
              <span>
                早期输出已从当前视图卸载
                {typeof block.toolOutputOriginalChars === 'number'
                  ? `，原始约 ${block.toolOutputOriginalChars.toLocaleString()} 字`
                  : typeof block.toolOutputOriginalBytes === 'number'
                    ? `，原始约 ${block.toolOutputOriginalBytes.toLocaleString()} 字节`
                    : ''}
                。
              </span>
              {onLoadFullTranscript ? (
                <button
                  type="button"
                  data-testid="load-full-runtime-transcript-button"
                  onClick={() => void onLoadFullTranscript()}
                  disabled={loadingFullTranscript}
                  className="h-8 rounded border border-border bg-base px-2 text-xs font-medium text-text-secondary hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                >
                  {loadingFullTranscript ? '正在加载完整输出' : '加载完整输出'}
                </button>
              ) : null}
            </div>
          ) : null}
          <pre
            ref={outputRef}
            className="mt-1 max-h-48 max-w-full overflow-auto font-mono text-xs leading-5 text-text-secondary"
            data-testid="shell-tool-output"
          >
            {outputText}
          </pre>
        </>
      )}
      {(isDone || isError) && (
        <div className="mt-2 flex justify-end">
          {isDone && (
            <span className="flex items-center gap-1 text-xs text-text-muted">
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              成功
            </span>
          )}
          {isError && <span className="text-xs text-red-500">失败</span>}
        </div>
      )}
    </div>
  )
}

function FileWriteDetail({ block }: { block: ToolBlock }) {
  const filePaths = getFileInputPaths(block)
  const content = getInputField(block, 'content', 'file_text', 'fileText')
  return (
    <div className="min-w-0 space-y-1 overflow-x-hidden">
      {filePaths.map(filePath => (
        <p key={filePath} className="break-words text-xs text-text-muted">
          {filePath}
        </p>
      ))}
      {content && (
        <pre className="max-h-40 max-w-full overflow-auto rounded-lg bg-code-bg px-3 py-2 text-xs leading-5 text-text-primary">
          {content.length > 500 ? content.substring(0, 500) + '...' : content}
        </pre>
      )}
    </div>
  )
}

function FileEditDetail({ block }: { block: ToolBlock }) {
  const filePaths = getFileInputPaths(block)
  const previews = getEditPreviews(block)
  return (
    <div className="min-w-0 space-y-1 overflow-x-hidden">
      {filePaths.map(filePath => (
        <p key={filePath} className="break-words text-xs text-text-muted">
          {filePath}
        </p>
      ))}
      {previews.map((preview, index) => (
        <div
          key={`${index}:${preview.oldText ?? ''}:${preview.newText ?? ''}`}
          className="space-y-1"
        >
          {preview.oldText && (
            <pre className="max-h-24 max-w-full overflow-auto rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
              {truncate(preview.oldText, 300)}
            </pre>
          )}
          {preview.newText && (
            <pre className="max-h-24 max-w-full overflow-auto rounded-lg bg-green-50 px-3 py-2 text-xs leading-5 text-green-700">
              {truncate(preview.newText, 300)}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

function getEditPreviews(block: ToolBlock): Array<{ oldText?: string; newText?: string }> {
  const directOldText = getInputField(block, 'old_string', 'old_str', 'oldString')
  const directNewText = getInputField(block, 'new_string', 'new_str', 'newString', 'new_source')
  if (directOldText || directNewText) {
    return [{ oldText: directOldText, newText: directNewText }]
  }

  const edits = block.toolInput?.edits
  if (!Array.isArray(edits)) return []

  return edits.flatMap(edit => {
    if (!isRecord(edit)) return []
    const oldText = getStringField(edit, 'old_string', 'old_str', 'oldString')
    const newText = getStringField(edit, 'new_string', 'new_str', 'newString')
    return oldText || newText ? [{ oldText, newText }] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.substring(0, maxLen) + '...'
}
