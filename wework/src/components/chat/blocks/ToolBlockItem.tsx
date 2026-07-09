import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, Copy, CopyCheck, FileDiff, Search } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { useTranslation } from '@/hooks/useTranslation'
import type { TurnFileChangeItem, TurnFileChangesSummary } from '@/types/api'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import { AssistantPlanCard, type AssistantPlanOpenRequest } from '../AssistantPlanCard'
import { MarkdownCodeBlock } from '../MarkdownCodeBlock'
import { parseUnifiedDiff } from '../parseUnifiedDiff'
import { isWebSearchToolName } from './toolBlockActivity'
import {
  getFileInputPath,
  getFileInputPaths,
  getInputField,
  isCommandToolName,
  isFileCreateToolName,
  isFileEditToolName,
  isGuidanceToolName,
  isFileReadToolName,
} from './toolBlockKinds'
import { WebSearchActivityRows } from './WebSearchSources'
import { getWebSearchActivityItems } from './webSearchActivity'

const THINKING_PREVIEW_MAX_LENGTH = 96
const INLINE_DIFF_MAX_LINES = 96

interface ToolBlockItemProps {
  block: ProcessingBlock
  forceExpanded?: boolean
  stateKey?: string
  onOpenWorkspaceFile?: (path: string) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
}

export function ToolBlockItem({
  block,
  forceExpanded = false,
  onOpenWorkspaceFile,
  onOpenAssistantPlan,
}: ToolBlockItemProps) {
  const [userExpanded, setUserExpanded] = useState(false)
  const isRunning = block.status !== 'done' && block.status !== 'error'

  if (block.type === 'thinking') {
    return <ThinkingBlockItem block={block} isRunning={isRunning} />
  }
  if (block.type === 'text') {
    return <ProcessTextBlockItem block={block} isRunning={isRunning} />
  }
  if (block.type === 'plan') {
    return <PlanBlockItem block={block} onOpenAssistantPlan={onOpenAssistantPlan} />
  }
  if (block.type === 'file_changes') {
    return <ProcessFileChangesBlockItem block={block} />
  }

  const { icon, label } = getBlockLabel(block)
  const workspaceFilePath = getWorkspaceFilePath(block)
  const hasDetail = hasBlockDetail(block)
  const expanded = hasDetail && (forceExpanded || userExpanded)
  const labelContent = (
    <>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {isRunning && <span className="animate-pulse text-xs will-change-opacity">...</span>}
    </>
  )

  return (
    <div className="min-w-0 overflow-x-hidden text-[13px]" data-processing-block-id={block.id}>
      <div className="flex max-w-full items-center gap-1.5 text-text-secondary">
        {workspaceFilePath && onOpenWorkspaceFile ? (
          <button
            type="button"
            onClick={() => onOpenWorkspaceFile(workspaceFilePath)}
            className="flex min-w-0 items-center gap-1.5 hover:text-text-primary"
          >
            {labelContent}
          </button>
        ) : hasDetail ? (
          <button
            type="button"
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
      </div>
      {expanded ? (
        <div className="mt-2 min-w-0 overflow-x-hidden">{renderBlockDetail(block)}</div>
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
}: {
  block: Extract<ProcessingBlock, { type: 'file_changes' }>
}) {
  const { t } = useTranslation('chat')
  const summary = block.fileChanges
  const isRunning = block.status !== 'done' && block.status !== 'error'
  const [expanded, setExpanded] = useState(false)
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null)

  if (!summary.files.length) return null

  return (
    <div
      className="min-w-0 overflow-visible text-[13px]"
      data-processing-block-id={block.id}
      data-testid="process-file-changes-block"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex max-w-full items-center gap-1.5 text-text-muted hover:text-text-secondary"
      >
        <FileDiff className="h-4 w-4 shrink-0" strokeWidth={1.7} />
        <span className="min-w-0 truncate">{fileChangesSummaryLabel(summary, t, isRunning)}</span>
        <FileChangeLineStats summary={summary} isRunning={isRunning} />
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
          strokeWidth={2}
        />
      </button>
      {expanded ? (
        <div className="mt-2 min-w-0 space-y-1.5">
          {summary.files.map(file => {
            const previewLines = fileDiffPreviewLines(file, summary)
            const fileExpanded = expandedFilePath === file.path && previewLines.length > 0
            return (
              <div key={`${file.old_path ?? ''}:${file.path}`} className="min-w-0">
                <button
                  type="button"
                  disabled={previewLines.length === 0}
                  onClick={() =>
                    setExpandedFilePath(current => (current === file.path ? null : file.path))
                  }
                  className="group flex max-w-full items-center gap-1.5 text-text-secondary disabled:cursor-default"
                >
                  <span className="min-w-0 truncate">{fileChangeRowLabel(file, t)}</span>
                  {!file.binary ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
                      <span className="text-green-600">+{file.additions}</span>
                      <span className="text-red-500">-{file.deletions}</span>
                    </span>
                  ) : null}
                  {previewLines.length > 0 ? (
                    <ChevronDown
                      className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform group-hover:text-text-secondary ${
                        fileExpanded ? '' : '-rotate-90'
                      }`}
                      strokeWidth={2}
                    />
                  ) : null}
                </button>
                {fileExpanded ? <InlineDiffPreview file={file} lines={previewLines} /> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

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
  summary,
  isRunning,
}: {
  summary: TurnFileChangesSummary
  isRunning: boolean
}) {
  const [statBlocks, setStatBlocks] = useState<FileChangeStatBlock[]>([])
  const visibleStatBlocks =
    isRunning && statBlocks.length > 0 ? statBlocks : buildStaticFileChangeStatBlocks(summary)
  const previousRef = useRef({
    artifactId: summary.artifact_id,
    additions: summary.additions,
    deletions: summary.deletions,
  })

  useEffect(() => {
    const previous = previousRef.current
    if (previous.artifactId !== summary.artifact_id) {
      previousRef.current = {
        artifactId: summary.artifact_id,
        additions: summary.additions,
        deletions: summary.deletions,
      }
      setStatBlocks([])
      return
    }

    const addedDelta = Math.max(0, summary.additions - previous.additions)
    const deletedDelta = Math.max(0, summary.deletions - previous.deletions)
    previousRef.current = {
      artifactId: summary.artifact_id,
      additions: summary.additions,
      deletions: summary.deletions,
    }

    if (!isRunning || (addedDelta === 0 && deletedDelta === 0)) return

    const now = Date.now()
    setStatBlocks(current =>
      [
        ...current,
        {
          id: `${now}-${addedDelta}-${deletedDelta}`,
          additions: addedDelta,
          deletions: deletedDelta,
        },
      ].slice(-6)
    )
  }, [isRunning, summary.additions, summary.artifact_id, summary.deletions])

  return (
    <span className="flex shrink-0 items-center gap-2 text-xs font-medium tabular-nums">
      <span className="inline-flex items-center text-green-600">
        +<AnimatedChangeNumber value={summary.additions} deltaPrefix="+" />
      </span>
      <span className="inline-flex items-center text-red-500">
        -<AnimatedChangeNumber value={summary.deletions} deltaPrefix="-" />
      </span>
      {visibleStatBlocks.length > 0 ? <FileChangeStatBlocks blocks={visibleStatBlocks} /> : null}
    </span>
  )
}

function buildStaticFileChangeStatBlocks(summary: TurnFileChangesSummary): FileChangeStatBlock[] {
  const changedFiles = summary.files.filter(file => !file.binary)
  if (changedFiles.length > 0) {
    return changedFiles.slice(-6).map(file => ({
      id: `${file.path}:${file.additions}:${file.deletions}`,
      additions: file.additions,
      deletions: file.deletions,
    }))
  }

  if (summary.additions === 0 && summary.deletions === 0) return []
  return [
    {
      id: `${summary.artifact_id}:${summary.additions}:${summary.deletions}`,
      additions: summary.additions,
      deletions: summary.deletions,
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

function fileChangesSummaryLabel(
  summary: TurnFileChangesSummary,
  t: ReturnType<typeof useTranslation>['t'],
  isRunning = false
): string {
  const changeType = uniformChangeType(summary.files)
  const count = summary.file_count || summary.files.length
  if (isRunning) {
    if (changeType === 'created') return t('file_changes.creating_files', { count })
    if (changeType === 'deleted') return t('file_changes.deleting_files', { count })
    if (changeType === 'renamed') return t('file_changes.renaming_files', { count })
    return t('file_changes.editing_files', { count })
  }
  if (changeType === 'created') return t('file_changes.created_files', { count })
  if (changeType === 'deleted') return t('file_changes.deleted_files', { count })
  if (changeType === 'renamed') return t('file_changes.renamed_files', { count })
  return t('file_changes.edited_files', { count })
}

function uniformChangeType(files: TurnFileChangeItem[]): TurnFileChangeItem['change_type'] | null {
  const first = files[0]?.change_type
  if (!first) return null
  return files.every(file => file.change_type === first) ? first : null
}

function fileChangeRowLabel(
  file: TurnFileChangeItem,
  t: ReturnType<typeof useTranslation>['t']
): string {
  const filename = basename(file.path)
  switch (file.change_type) {
    case 'created':
      return t('file_changes.created_file', { filename })
    case 'deleted':
      return t('file_changes.deleted_file', { filename })
    case 'renamed':
      return t('file_changes.renamed_file', { filename })
    case 'modified':
    default:
      return t('file_changes.edited_file', { filename })
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
  const visibleLines = lines.slice(0, INLINE_DIFF_MAX_LINES)
  const truncated = lines.length > INLINE_DIFF_MAX_LINES
  const copyText = formatDiffPreviewCopyText(visibleLines, truncated)

  const handleCopy = async () => {
    await copyCodeText(copyText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      ref={previewRef}
      className="mt-2 max-h-[16rem] min-w-0 select-text overflow-auto overscroll-contain rounded-lg border border-border bg-surface font-mono text-[12px] leading-[18px]"
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
  return parseDiffPreviewLines(sectionLines)
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

function parseDiffPreviewLines(lines: string[]): DiffPreviewLine[] {
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
        type: 'addition',
        lineNumber: newLine,
        content: rawLine.slice(1),
      })
      if (newLine !== undefined) newLine += 1
      return
    }
    if (prefix === '-') {
      previewLines.push({
        key: `deletion-${index}`,
        type: 'deletion',
        lineNumber: oldLine,
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

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function ThinkingBlockItem({
  block,
  isRunning,
}: {
  block: Extract<ProcessingBlock, { type: 'thinking' }>
  isRunning: boolean
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)

  if (!block.content) return null

  if (isRunning) {
    const preview = buildBlockPreview(block.content)

    return (
      <div className="min-w-0 overflow-x-hidden text-[13px]" data-processing-block-id={block.id}>
        <div
          className="flex max-w-full items-center gap-1.5 text-text-secondary"
          role="status"
          aria-live="polite"
          data-testid="thinking-live-preview"
        >
          <span className="shrink-0">{t('thinking.running')}</span>
          <span className="shrink-0 text-text-muted">·</span>
          <span className="min-w-0 truncate text-text-muted">
            {preview || t('thinking.updating')}
          </span>
        </div>
      </div>
    )
  }

  const charCount = block.content.length
  const detailId = `${block.id}-thinking-detail`

  return (
    <div className="min-w-0 overflow-x-hidden text-[13px]" data-processing-block-id={block.id}>
      <button
        type="button"
        data-testid="thinking-toggle-button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded(value => !value)}
        className="flex max-w-full items-center gap-1.5 text-text-muted hover:text-text-secondary"
      >
        <span className="min-w-0 truncate">
          {t('thinking.completed')} · {charCount} {t('thinking.chars')}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
          strokeWidth={2}
        />
      </button>
      {expanded && (
        <div
          id={detailId}
          className="mt-2 min-w-0 overflow-x-hidden border-l border-border pl-4"
          data-testid="thinking-detail"
        >
          <ProcessMarkdown content={block.content} />
        </div>
      )}
    </div>
  )
}

function ProcessTextBlockItem({
  block,
  isRunning,
}: {
  block: Extract<ProcessingBlock, { type: 'text' }>
  isRunning: boolean
}) {
  const { t } = useTranslation('chat')

  if (!block.content) return null

  return (
    <div
      className="min-w-0 overflow-x-hidden text-[13px] text-text-secondary"
      data-processing-block-id={block.id}
      role={isRunning ? 'status' : undefined}
      aria-live={isRunning ? 'polite' : undefined}
      aria-label={isRunning ? t('process_text.running') : undefined}
      data-testid="process-text-block"
    >
      <div className="min-w-0">
        <ProcessMarkdown content={block.content} />
      </div>
    </div>
  )
}

function ProcessMarkdown({ content }: { content: string }) {
  return (
    <div className="thinking-markdown min-w-0 break-words leading-6 text-text-secondary">
      <Streamdown
        mode="streaming"
        controls={false}
        lineNumbers={false}
        urlTransform={url => url}
        components={{
          p: ({ children }) => <p className="mb-1.5 min-w-0 break-words leading-6">{children}</p>,
          ul: ({ children }) => <ul className="mb-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => (
            <ol className="mb-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="min-w-0 break-words leading-6">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ className, children, node, ...props }) => {
            const match = /language-(\w*)/.exec(className || '')
            const text = reactNodeToText(children)
            const isBlock =
              ('data-block' in props && Boolean(props['data-block'])) ||
              node?.properties?.dataBlock === 'true' ||
              Boolean(match) ||
              text.includes('\n')
            if (isBlock) {
              const lang = match ? match[1] || '' : ''
              return (
                <MarkdownCodeBlock lang={lang} compact>
                  {text || children}
                </MarkdownCodeBlock>
              )
            }
            return (
              <code className="break-words rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-text-primary">
                {children}
              </code>
            )
          },
          inlineCode: ({ children }) => (
            <code className="break-words rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-text-primary">
              {children}
            </code>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-1.5 border-l-3 border-border pl-3 opacity-80">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="break-words text-primary underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Streamdown>
    </div>
  )
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeToText).join('')
  return ''
}

function getBlockLabel(block: ToolBlock): { icon: React.ReactNode; label: string } {
  const name = block.toolName.toLowerCase()
  const prefix = getToolStatusPrefix(block)

  if (isCommandToolName(name)) {
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
  if (isGuidanceToolName(name)) {
    return { icon: <ToolIcon />, label: prefix.guidance }
  }
  return { icon: <ToolIcon />, label: prefix.generic }
}

function getFileToolLabel(prefix: string, block: ToolBlock, action: string): string {
  const filePaths = getFileInputPaths(block)
  if (filePaths.length === 1) return `${prefix} ${basename(filePaths[0])}`
  if (filePaths.length > 1) return `${prefix} ${filePaths.length} 个文件`
  return fileToolFallbackLabel(block.status, action)
}

function fileToolFallbackLabel(status: ToolBlock['status'], action: string): string {
  if (status === 'error') return `${action}文件失败`
  if (status === 'done') return `已${action}文件`
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
      running: '已运行',
      create: '已新增',
      edit: '已编辑',
      read: '已读取',
      webSearch: '已搜索网页',
      guidance: '已引导对话',
      generic: '已执行',
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

function renderBlockDetail(block: ToolBlock) {
  const name = block.toolName.toLowerCase()

  if (isCommandToolName(name)) {
    return <BashBlockDetail block={block} />
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
  if (isGuidanceToolName(name)) {
    return null
  }

  return null
}

function hasBlockDetail(block: ToolBlock): boolean {
  const name = block.toolName.toLowerCase()
  return (
    isCommandToolName(name) ||
    isFileCreateToolName(name) ||
    isFileEditToolName(name) ||
    isWebSearchToolName(name)
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

function BashBlockDetail({ block }: { block: ToolBlock }) {
  const command = getInputField(block, 'command', 'cmd', 'commandLine')
  const cwd = getInputField(block, 'cwd', 'workdir', 'workingDirectory')
  const output = block.toolOutput
  const outputText =
    typeof output === 'string' ? output : output ? JSON.stringify(output, null, 2) : ''
  const isDone = block.status === 'done'
  const isError = block.status === 'error'
  const [copied, setCopied] = useState(false)

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
        <pre className="mt-1 max-h-48 max-w-full overflow-auto font-mono text-xs leading-5 text-text-secondary">
          {outputText.length > 2000 ? outputText.substring(0, 2000) + '...' : outputText}
        </pre>
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

function buildBlockPreview(content: string): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[#>*_[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''

  const segments = normalized
    .split(/[。！？!?]+|\.(?=\s|$)/)
    .map(segment => segment.trim())
    .filter(Boolean)
  const preview = segments[segments.length - 1] ?? normalized

  return truncate(preview, THINKING_PREVIEW_MAX_LENGTH)
}
