import { Check, ChevronDown, ChevronUp, FileDiff, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '@/api/http'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import type { TurnFileChangeItem, TurnFileChangesSummary } from '@/types/api'
import { parseUnifiedDiff, type DiffFileSection } from './parseUnifiedDiff'

const DEFAULT_VISIBLE_FILE_COUNT = 3
const INLINE_DIFF_MAX_FILES = 3
const INLINE_DIFF_MAX_LINES = 80

interface FileChangesCardProps {
  subtaskId: number
  summary: TurnFileChangesSummary
  deviceOnline: boolean
  onLoadDiff: (subtaskId: number) => Promise<string>
  onRevert: (subtaskId: number) => Promise<TurnFileChangesSummary>
  onOpenReview?: (request: {
    subtaskId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
  }) => void
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return fallback
}

function FileChangeRow({
  file,
  disabled,
  onPreview,
}: {
  file: TurnFileChangeItem
  disabled: boolean
  onPreview: () => void
}) {
  const { t } = useTranslation('chat')
  const displayPath =
    file.change_type === 'renamed' && file.old_path ? `${file.old_path} → ${file.path}` : file.path

  return (
    <button
      type="button"
      data-testid="file-change-row"
      disabled={disabled}
      onClick={onPreview}
      className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent"
      aria-label={t('file_changes.preview_file_label', { path: displayPath })}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-text-primary">{displayPath}</span>
      {file.binary ? (
        <span className="shrink-0 text-text-muted">{t('file_changes.binary_file')}</span>
      ) : (
        <span className="flex shrink-0 items-center gap-2 font-medium">
          <span className="text-green-600">+{file.additions}</span>
          <span className="text-red-500">-{file.deletions}</span>
        </span>
      )}
    </button>
  )
}

export function FileChangesCard({
  subtaskId,
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
  const actionsDisabled = !deviceOnline || summary.status === 'artifact_missing'
  const reviewDisabled = actionsDisabled || !onOpenReview
  const canRevert = summary.status === 'active' && summary.revertible !== false
  const inlineDiff = summary.diff?.trim()

  const openReview = () => {
    onOpenReview?.({
      subtaskId,
      loadDiff: () => onLoadDiff(subtaskId),
      reviewTitle: t('file_changes.previous_turn_label'),
      defaultFileTreeVisible: false,
    })
  }

  const revert = async () => {
    setReverting(true)
    setActionError(undefined)
    try {
      await onRevert(subtaskId)
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
        className="mt-3 overflow-hidden rounded-xl border border-border bg-base"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
            <FileDiff className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-primary">
              {t('file_changes.edited_files', {
                count: summary.file_count,
              })}
            </p>
            <p className="flex gap-2 text-xs font-medium">
              <span className="text-green-600">+{summary.additions}</span>
              <span className="text-red-500">-{summary.deletions}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {summary.status === 'reverted' ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary">
                <Check className="h-3.5 w-3.5" />
                {t('file_changes.reverted')}
              </span>
            ) : null}
            <button
              type="button"
              data-testid="review-file-changes-button"
              disabled={reviewDisabled}
              onClick={() => void openReview()}
              className="h-7 rounded border border-border px-2 text-xs font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('file_changes.review')}
            </button>
            {canRevert ? (
              <button
                type="button"
                data-testid="revert-file-changes-button"
                disabled={actionsDisabled}
                onClick={() => setConfirmOpen(true)}
                className="flex h-7 items-center justify-center gap-1 rounded px-2 text-xs font-medium text-text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('file_changes.revert')}
              </button>
            ) : null}
          </div>
        </div>
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
        {inlineDiff ? (
          <InlineDiffPreview diff={inlineDiff} files={summary.files} />
        ) : (
          <div className="divide-y divide-border/70">
            {visibleFiles.map(file => (
              <FileChangeRow
                key={`${file.old_path ?? ''}:${file.path}`}
                file={file}
                disabled={reviewDisabled}
                onPreview={() => openReview()}
              />
            ))}
          </div>
        )}
        {!inlineDiff && hiddenCount > 0 ? (
          <button
            type="button"
            data-testid="toggle-file-changes-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}
            className="flex h-8 w-full items-center gap-1 border-t border-border px-3 text-xs font-medium text-text-secondary hover:bg-muted"
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {expanded
              ? t('file_changes.show_less')
              : t('file_changes.show_more', { count: hiddenCount })}
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

function InlineDiffPreview({
  diff,
  files,
}: {
  diff: string
  files: TurnFileChangeItem[]
}) {
  const sections = parseUnifiedDiff(diff).slice(0, INLINE_DIFF_MAX_FILES)
  const sectionsToRender =
    sections.length > 0 ? sections : [{ path: files[0]?.path ?? 'diff', lines: diff.split('\n') }]

  return (
    <div data-testid="file-changes-inline-diff" className="border-t border-border bg-base">
      <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-text-secondary">
        已编辑的文件
      </div>
      <div className="space-y-2 bg-surface/60 px-3 py-2">
        {sectionsToRender.map((section, index) => (
          <InlineDiffFile
            key={`${section.oldPath ?? ''}:${section.path}:${index}`}
            section={section}
            file={files.find(item => item.path === section.path)}
          />
        ))}
      </div>
    </div>
  )
}

function InlineDiffFile({
  section,
  file,
}: {
  section: DiffFileSection
  file?: TurnFileChangeItem
}) {
  const rows = buildInlineDiffRows(section.lines).slice(0, INLINE_DIFF_MAX_LINES)
  const additions = file?.additions ?? rows.filter(row => row.kind === 'added').length
  const deletions = file?.deletions ?? rows.filter(row => row.kind === 'removed').length

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-base">
      <div className="flex min-h-8 items-center gap-2 border-b border-border bg-surface px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">{section.path}</span>
        <span className="shrink-0 font-medium text-green-600">+{additions}</span>
        <span className="shrink-0 font-medium text-red-500">-{deletions}</span>
      </div>
      <pre className="max-h-72 overflow-auto bg-base text-xs leading-5">
        {rows.map((row, index) => (
          <code
            key={`${index}:${row.content}`}
            className={[
              'grid min-w-max grid-cols-[3.5rem_1fr] font-mono',
              row.kind === 'added' ? 'bg-green-50 text-green-800' : '',
              row.kind === 'removed' ? 'bg-red-50 text-red-800' : '',
              row.kind === 'hunk' ? 'bg-blue-50 text-blue-700' : '',
              row.kind === 'context' ? 'text-text-primary' : '',
            ].join(' ')}
          >
            <span className="select-none border-r border-border/70 px-2 text-right text-text-muted">
              {row.lineNumber ?? ''}
            </span>
            <span className="px-3">{row.content}</span>
          </code>
        ))}
      </pre>
    </div>
  )
}

interface InlineDiffRow {
  content: string
  lineNumber: number | null
  kind: 'added' | 'removed' | 'context' | 'hunk'
}

function buildInlineDiffRows(lines: string[]): InlineDiffRow[] {
  const rows: InlineDiffRow[] = []
  let oldLine: number | null = null
  let newLine: number | null = null

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1])
      newLine = Number(hunkMatch[2])
      rows.push({ content: line, lineNumber: null, kind: 'hunk' })
      continue
    }
    if (shouldSkipDiffMetadata(line)) continue
    const row = createInlineDiffRow(line, oldLine, newLine)
    rows.push(row)
    if (oldLine !== null && row.kind !== 'added') oldLine += 1
    if (newLine !== null && row.kind !== 'removed') newLine += 1
  }

  return rows
}

function createInlineDiffRow(
  line: string,
  oldLine: number | null,
  newLine: number | null
): InlineDiffRow {
  if (line.startsWith('+')) {
    return { content: line, lineNumber: newLine, kind: 'added' }
  }
  if (line.startsWith('-')) {
    return { content: line, lineNumber: oldLine, kind: 'removed' }
  }
  return { content: line, lineNumber: newLine ?? oldLine, kind: 'context' }
}

function shouldSkipDiffMetadata(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
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
