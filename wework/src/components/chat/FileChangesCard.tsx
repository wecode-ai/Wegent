import { ArrowUpRight, Check, ChevronDown, ChevronUp, FileDiff, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '@/api/http'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import type { TurnFileChangeItem, TurnFileChangesSummary } from '@/types/api'
import { parseUnifiedDiff } from './parseUnifiedDiff'

const DEFAULT_VISIBLE_FILE_COUNT = 3
const DIFF_PREVIEW_CLOSE_DELAY_MS = 140
const DIFF_PREVIEW_DELAY_MS = 500
const DIFF_PREVIEW_ESTIMATED_HEIGHT = 424
const DIFF_PREVIEW_MAX_LINES = 240
const DIFF_PREVIEW_MAX_WIDTH = 640
const DIFF_PREVIEW_VIEWPORT_GUTTER = 32
const DIFF_PREVIEW_VERTICAL_GAP = 8

interface FileChangesCardProps {
  turnId: number
  summary: TurnFileChangesSummary
  deviceOnline: boolean
  onLoadDiff: (turnId: number) => Promise<string>
  onRevert: (turnId: number) => Promise<TurnFileChangesSummary>
  onOpenReview?: (request: {
    turnId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return fallback
}

function FileChangeRow({
  file,
  summary,
  disabled,
  onPreview,
}: {
  file: TurnFileChangeItem
  summary: TurnFileChangesSummary
  disabled: boolean
  onPreview: () => void
}) {
  const { t } = useTranslation('chat')
  const displayPath =
    file.change_type === 'renamed' && file.old_path ? `${file.old_path} → ${file.path}` : file.path
  const diffPreview = buildFileDiffPreview(file, summary)
  const {
    close: closeDiffPreview,
    keepOpen: keepDiffPreviewOpen,
    openAfterDelay: openDiffPreviewAfterDelay,
    placement: diffPreviewPlacement,
    position: diffPreviewPosition,
    previewOpen: diffPreviewOpen,
    triggerRef: diffPreviewTriggerRef,
  } = useDelayedDiffPreview(diffPreview)

  return (
    <div
      data-testid="file-change-row"
      className="group/file-change-row flex min-w-0 items-center px-4 py-2.5 transition-colors hover:bg-muted"
    >
      <div
        ref={diffPreviewTriggerRef}
        data-testid="file-change-trigger"
        className="group/file-change-trigger relative min-w-0 flex-1"
        onPointerEnter={openDiffPreviewAfterDelay}
        onPointerLeave={closeDiffPreview}
        onFocus={openDiffPreviewAfterDelay}
        onBlur={closeDiffPreview}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={onPreview}
          className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={t('file_changes.preview_file_label', { path: displayPath })}
        >
          <span
            data-testid="file-change-title-label"
            className="min-w-0 truncate text-[13px] font-medium leading-5 text-text-primary"
          >
            {displayPath}
          </span>
          {file.binary ? (
            <span className="shrink-0 text-xs leading-5 text-text-secondary">
              {t('file_changes.binary_file')}
            </span>
          ) : (
            <span className="relative h-5 min-w-[5.5rem] text-xs font-medium leading-5">
              <span
                data-testid="file-change-stats-label"
                className="flex justify-end gap-2 group-hover/file-change-trigger:hidden group-focus-within/file-change-trigger:hidden"
              >
                <span className="text-green-600">+{file.additions}</span>
                <span className="text-red-500">-{file.deletions}</span>
              </span>
              <span
                data-testid="file-change-view-label"
                className="hidden justify-end gap-1 truncate text-text-secondary group-hover/file-change-trigger:flex group-focus-within/file-change-trigger:flex"
              >
                {t('file_changes.view_changes')}
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.8} />
              </span>
            </span>
          )}
        </button>
        {diffPreviewOpen && diffPreview ? (
          <FileChangeDiffPreview
            preview={diffPreview}
            placement={diffPreviewPlacement}
            position={diffPreviewPosition}
            onPointerEnter={keepDiffPreviewOpen}
            onPointerLeave={closeDiffPreview}
          />
        ) : null}
      </div>
    </div>
  )
}

function FileChangeSummaryTrigger({
  file,
  summary,
  disabled,
  onPreview,
}: {
  file: TurnFileChangeItem
  summary: TurnFileChangesSummary
  disabled: boolean
  onPreview: () => void
}) {
  const { t } = useTranslation('chat')
  const displayPath =
    file.change_type === 'renamed' && file.old_path ? `${file.old_path} → ${file.path}` : file.path
  const filename = basename(file.path)
  const diffPreview = buildFileDiffPreview(file, summary)
  const {
    close: closeDiffPreview,
    keepOpen: keepDiffPreviewOpen,
    openAfterDelay: openDiffPreviewAfterDelay,
    placement: diffPreviewPlacement,
    position: diffPreviewPosition,
    previewOpen: diffPreviewOpen,
    triggerRef: diffPreviewTriggerRef,
  } = useDelayedDiffPreview(diffPreview)

  return (
    <div
      ref={diffPreviewTriggerRef}
      data-testid="file-change-trigger"
      className="group/file-change-trigger relative min-w-0 flex-1 self-stretch"
      onPointerEnter={openDiffPreviewAfterDelay}
      onPointerLeave={closeDiffPreview}
      onFocus={openDiffPreviewAfterDelay}
      onBlur={closeDiffPreview}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onPreview}
        className="flex h-full w-full min-w-0 items-center gap-3 rounded-lg text-left disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={t('file_changes.preview_file_label', { path: displayPath })}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-base text-text-secondary">
          <FileDiff className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            data-testid="file-changes-summary-title"
            className="block truncate text-[13px] font-semibold leading-5 text-text-primary"
          >
            {t(fileChangeLabelKey(file.change_type), { filename })}
          </span>
          {file.binary ? (
            <span className="block truncate text-xs leading-5 text-text-secondary">
              {t('file_changes.binary_file')}
            </span>
          ) : (
            <span className="relative block h-5 text-xs font-medium leading-5">
              <span
                data-testid="file-change-stats-label"
                className="flex items-center gap-2 group-hover/file-change-trigger:hidden group-focus-within/file-change-trigger:hidden"
              >
                <span className="text-green-600">+{summary.additions}</span>
                <span className="text-red-500">-{summary.deletions}</span>
              </span>
              <span
                data-testid="file-change-view-label"
                className="hidden items-center gap-1 truncate text-text-secondary group-hover/file-change-trigger:flex group-focus-within/file-change-trigger:flex"
              >
                {t('file_changes.view_changes')}
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.8} />
              </span>
            </span>
          )}
        </span>
      </button>
      {diffPreviewOpen && diffPreview ? (
        <FileChangeDiffPreview
          preview={diffPreview}
          placement={diffPreviewPlacement}
          position={diffPreviewPosition}
          onPointerEnter={keepDiffPreviewOpen}
          onPointerLeave={closeDiffPreview}
        />
      ) : null}
    </div>
  )
}

function fileChangeLabelKey(changeType: TurnFileChangeItem['change_type']) {
  switch (changeType) {
    case 'created':
      return 'file_changes.created_file'
    case 'deleted':
      return 'file_changes.deleted_file'
    case 'renamed':
      return 'file_changes.renamed_file'
    case 'modified':
    default:
      return 'file_changes.edited_file'
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

interface DiffPreview {
  path: string
  displayPath: string
  additions: number
  deletions: number
  lines: DiffPreviewLine[]
  truncated: boolean
}

type DiffPreviewPlacement = 'above' | 'below'

interface DiffPreviewPosition {
  left: number
  top: number
  width: number
}

interface DiffPreviewLine {
  key: string
  type: 'addition' | 'deletion' | 'context' | 'separator'
  lineNumber?: number
  content: string
}

function FileChangesStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex items-center gap-2 text-xs font-medium leading-5">
      <span className="text-green-600">+{additions}</span>
      <span className="text-red-500">-{deletions}</span>
    </span>
  )
}

function useDelayedDiffPreview(preview: DiffPreview | null) {
  const triggerRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [placement, setPlacement] = useState<DiffPreviewPlacement>('above')
  const [position, setPosition] = useState<DiffPreviewPosition>()

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
      }
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current)
      }
    },
    []
  )

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const clearOpenTimer = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }

  const openAfterDelay = () => {
    if (!preview) return
    clearCloseTimer()
    clearOpenTimer()
    openTimerRef.current = window.setTimeout(() => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) {
        const spaceAbove = rect.top
        const spaceBelow = window.innerHeight - rect.bottom
        const nextPlacement =
          spaceAbove < DIFF_PREVIEW_ESTIMATED_HEIGHT && spaceBelow > spaceAbove ? 'below' : 'above'
        const width = Math.min(
          DIFF_PREVIEW_MAX_WIDTH,
          Math.max(280, window.innerWidth - DIFF_PREVIEW_VIEWPORT_GUTTER * 2)
        )
        const maxLeft = window.innerWidth - width - DIFF_PREVIEW_VIEWPORT_GUTTER
        const left = Math.min(Math.max(rect.left, DIFF_PREVIEW_VIEWPORT_GUTTER), maxLeft)
        const top =
          nextPlacement === 'above'
            ? Math.max(DIFF_PREVIEW_VIEWPORT_GUTTER, rect.top - DIFF_PREVIEW_VERTICAL_GAP)
            : rect.bottom + DIFF_PREVIEW_VERTICAL_GAP

        setPlacement(nextPlacement)
        setPosition({ left, top, width })
      }
      setPreviewOpen(true)
      openTimerRef.current = null
    }, DIFF_PREVIEW_DELAY_MS)
  }

  const keepOpen = () => {
    clearCloseTimer()
  }

  const close = () => {
    clearOpenTimer()
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setPreviewOpen(false)
      closeTimerRef.current = null
    }, DIFF_PREVIEW_CLOSE_DELAY_MS)
  }

  return {
    close,
    keepOpen,
    openAfterDelay,
    placement,
    position,
    previewOpen,
    triggerRef,
  }
}

function FileChangeDiffPreview({
  onPointerEnter,
  onPointerLeave,
  preview,
  placement,
  position,
}: {
  onPointerEnter: () => void
  onPointerLeave: () => void
  preview: DiffPreview
  placement: DiffPreviewPlacement
  position?: DiffPreviewPosition
}) {
  const content = (
    <div
      data-testid="file-change-diff-preview"
      data-placement={placement}
      style={{
        left: position?.left,
        top: position?.top,
        width: position?.width,
        transform: placement === 'above' ? 'translateY(-100%)' : undefined,
      }}
      className="pointer-events-auto fixed z-[9999] max-w-[calc(100vw-4rem)] select-text overflow-hidden rounded-xl border border-border bg-popover text-left text-text-primary shadow-2xl"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="flex h-10 items-center gap-3 border-b border-border px-4 text-[13px] font-semibold">
        <span className="min-w-0 flex-1 truncate" title={preview.displayPath}>
          {preview.displayPath}
        </span>
        <span className="shrink-0 font-medium text-green-400">+{preview.additions}</span>
        <span className="shrink-0 font-medium text-red-400">-{preview.deletions}</span>
      </div>
      <div className="max-h-[min(24rem,calc(100vh-9rem))] overflow-auto py-1 font-mono text-[12px] leading-5">
        {preview.lines.map(line =>
          line.type === 'separator' ? (
            <div key={line.key} className="my-1 h-px bg-border" />
          ) : (
            <div
              key={line.key}
              className={[
                'grid min-w-full grid-cols-[3.5rem_max-content] overflow-visible',
                line.type === 'addition'
                  ? 'border-l-4 border-green-400 bg-green-500/10'
                  : line.type === 'deletion'
                    ? 'border-l-4 border-red-400 bg-red-500/10'
                    : 'border-l-4 border-transparent',
              ].join(' ')}
            >
              <span
                className={[
                  'select-none px-3 text-right',
                  line.type === 'addition'
                    ? 'text-green-400'
                    : line.type === 'deletion'
                      ? 'text-red-400'
                      : 'text-text-muted',
                ].join(' ')}
              >
                {line.lineNumber ?? ''}
              </span>
              <span className="pr-4 whitespace-pre">{line.content || ' '}</span>
            </div>
          )
        )}
        {preview.truncated ? <div className="px-4 py-1 text-xs text-text-muted">...</div> : null}
      </div>
    </div>
  )

  return createPortal(content, document.body)
}

function buildFileDiffPreview(
  file: TurnFileChangeItem,
  summary: TurnFileChangesSummary
): DiffPreview | null {
  if (file.binary || !summary.diff?.trim()) return null

  const sectionLines = fileDiffLines(file, summary)
  if (!sectionLines.length) return null

  const lines = parseDiffPreviewLines(sectionLines)
  if (!lines.length) return null

  return {
    path: file.path,
    displayPath: absoluteFilePath(summary.workspace_path, file.path),
    additions: file.additions,
    deletions: file.deletions,
    lines: lines.slice(0, DIFF_PREVIEW_MAX_LINES),
    truncated: lines.length > DIFF_PREVIEW_MAX_LINES,
  }
}

function absoluteFilePath(workspacePath: string, filePath: string): string {
  if (isAbsolutePath(filePath)) return filePath
  const normalizedWorkspacePath = workspacePath.replace(/[\\/]+$/, '')
  if (!normalizedWorkspacePath) return filePath
  return `${normalizedWorkspacePath}/${filePath.replace(/^[\\/]+/, '')}`
}

function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)
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
      rawLine.startsWith('+++')
    ) {
      return
    }
    if (
      rawLine.startsWith('index ') ||
      rawLine.startsWith('new file mode ') ||
      rawLine.startsWith('deleted file mode ') ||
      rawLine.startsWith('similarity index ') ||
      rawLine.startsWith('rename from ') ||
      rawLine.startsWith('rename to ') ||
      rawLine.startsWith('\\ No newline')
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

    if (!seenHunk && !rawLine.startsWith('+') && !rawLine.startsWith('-')) {
      return
    }

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

export function FileChangesCard({
  turnId,
  summary,
  deviceOnline,
  onLoadDiff,
  onRevert,
  onOpenReview,
}: FileChangesCardProps) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const hiddenCount = Math.max(0, summary.files.length - DEFAULT_VISIBLE_FILE_COUNT)
  const visibleFiles = expanded ? summary.files : summary.files.slice(0, DEFAULT_VISIBLE_FILE_COUNT)
  const singleFile = summary.files.length === 1 ? summary.files[0] : undefined
  const shownFileCount = summary.file_count || summary.files.length
  const actionsDisabled = !deviceOnline || summary.status === 'artifact_missing'
  const reviewDisabled = actionsDisabled || !onOpenReview
  const showRevert = summary.status === 'active'
  const revertDisabled = true

  const openReview = (focusFilePath?: string) => {
    onOpenReview?.({
      turnId,
      loadDiff: () => onLoadDiff(turnId),
      reviewTitle: t('file_changes.previous_turn_label'),
      defaultFileTreeVisible: false,
      focusFilePath,
    })
  }

  const revert = async () => {
    setReverting(true)
    setActionError(undefined)
    try {
      await onRevert(turnId)
      setConfirmOpen(false)
    } catch (error) {
      setActionError(getErrorMessage(error, t('file_changes.revert_failed')))
      setConfirmOpen(false)
    } finally {
      setReverting(false)
    }
  }

  return (
    <>
      <section
        data-testid="file-changes-card"
        className="mt-3 overflow-visible rounded-xl border border-border bg-surface"
      >
        {summary.status === 'conflicted' ? (
          <p className="border-b border-border bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            {t('file_changes.conflicted')}
          </p>
        ) : null}
        {summary.status === 'artifact_missing' ? (
          <p className="border-b border-border bg-surface px-3 py-1.5 text-xs text-text-muted">
            {t('file_changes.artifact_missing')}
          </p>
        ) : null}
        {!deviceOnline ? (
          <p className="border-b border-border bg-surface px-3 py-1.5 text-xs text-text-muted">
            {t('file_changes.device_offline')}
          </p>
        ) : null}
        {actionError ? (
          <p className="border-b border-border bg-red-50 px-3 py-1.5 text-xs text-red-700">
            {actionError}
          </p>
        ) : null}
        <div
          className={[
            'flex min-h-[4.5rem] items-center gap-3 px-4 py-3',
            singleFile ? '' : 'border-b border-border/70',
          ].join(' ')}
        >
          {singleFile ? (
            <FileChangeSummaryTrigger
              file={singleFile}
              summary={summary}
              disabled={reviewDisabled}
              onPreview={() => openReview(singleFile.path)}
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-base text-text-secondary">
                <FileDiff className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  data-testid="file-changes-summary-title"
                  className="block truncate text-[13px] font-semibold leading-5 text-text-primary"
                >
                  {t('file_changes.edited_files', { count: shownFileCount })}
                </span>
                <FileChangesStats additions={summary.additions} deletions={summary.deletions} />
              </span>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {summary.status === 'reverted' ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary">
                <Check className="h-3.5 w-3.5" />
                {t('file_changes.reverted')}
              </span>
            ) : null}
            {showRevert ? (
              <button
                type="button"
                data-testid="revert-file-changes-button"
                disabled={revertDisabled}
                onClick={() => setConfirmOpen(true)}
                className="flex h-8 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-text-primary hover:bg-base disabled:cursor-not-allowed disabled:text-text-muted disabled:opacity-50"
              >
                {t('file_changes.revert')}
                <Undo2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              data-testid="review-file-changes-button"
              disabled={reviewDisabled}
              onClick={() => void openReview()}
              className="h-8 rounded-lg border border-border bg-base px-3 text-xs font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('file_changes.review')}
            </button>
          </div>
        </div>
        {singleFile ? null : (
          <div className="divide-y divide-border/70">
            {visibleFiles.map(file => (
              <FileChangeRow
                key={`${file.old_path ?? ''}:${file.path}`}
                file={file}
                summary={summary}
                disabled={reviewDisabled}
                onPreview={() => openReview(file.path)}
              />
            ))}
          </div>
        )}
        {!singleFile && hiddenCount > 0 ? (
          <button
            type="button"
            data-testid="toggle-file-changes-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}
            className="flex h-8 w-full items-center gap-1 px-4 text-xs font-medium text-text-secondary hover:bg-muted"
          >
            <span>
              {expanded
                ? t('file_changes.show_less')
                : t('file_changes.show_more', { count: hiddenCount })}
            </span>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
      </section>
      <ConfirmRevertDialog
        open={confirmOpen}
        submitting={reverting}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void revert()}
      />
    </>
  )
}

function ConfirmRevertDialog({
  open,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean
  submitting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('chat')
  useEscapeKey(onClose, open && !submitting)

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-revert-file-changes-title"
        className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="confirm-revert-file-changes-title"
              className="text-base font-semibold text-text-primary"
            >
              {t('file_changes.confirm_revert_title')}
            </h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              {t('file_changes.confirm_revert_description')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-text-muted hover:bg-muted"
            aria-label={t('file_changes.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="primary" onClick={onClose} disabled={submitting}>
            {t('file_changes.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="confirm-revert-file-changes-button"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? t('file_changes.reverting') : t('file_changes.confirm_revert')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
