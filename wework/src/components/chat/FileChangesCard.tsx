import {
  Check,
  ChevronDown,
  ChevronUp,
  FileDiff,
  RotateCcw,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '@/api/http'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  TurnFileChangeItem,
  TurnFileChangesSummary,
} from '@/types/api'
import { parseUnifiedDiff } from './parseUnifiedDiff'

const DEFAULT_VISIBLE_FILE_COUNT = 3

interface FileChangesCardProps {
  subtaskId: number
  summary: TurnFileChangesSummary
  deviceOnline: boolean
  onLoadDiff: (subtaskId: number) => Promise<string>
  onRevert: (subtaskId: number) => Promise<TurnFileChangesSummary>
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return fallback
}

function getVisibleDiffLine(line: string) {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return null
  }

  if (line.startsWith('+')) {
    return { marker: '+', content: line.slice(1), className: 'bg-green-50 text-green-800' }
  }
  if (line.startsWith('-')) {
    return { marker: '-', content: line.slice(1), className: 'bg-red-50 text-red-800' }
  }
  if (line.startsWith('@@')) {
    return { marker: '', content: line, className: 'bg-surface text-text-secondary' }
  }

  return {
    marker: ' ',
    content: line.startsWith(' ') ? line.slice(1) : line,
    className: 'text-text-primary',
  }
}

function InlineFileDiff({
  file,
  diff,
  loading,
  error,
}: {
  file: TurnFileChangeItem
  diff: string
  loading: boolean
  error?: string
}) {
  const { t } = useTranslation('chat')
  const sections = parseUnifiedDiff(diff)
  const section = sections.find(item => item.path === file.path)
  const lines = section?.lines.map(getVisibleDiffLine).filter(Boolean) ?? []

  return (
    <div
      data-testid={`inline-file-diff-${file.path}`}
      className="border-t border-border bg-background"
    >
      {loading ? (
        <p className="px-3 py-6 text-center text-xs text-text-muted">
          {t('file_changes.loading_diff')}
        </p>
      ) : error ? (
        <p className="m-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : !section || lines.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-text-muted">
          {t('file_changes.empty_diff')}
        </p>
      ) : (
        <pre className="grid overflow-x-auto font-mono text-xs leading-5">
          {lines.map((line, index) => (
            <span
              key={`${index}-${line?.marker}-${line?.content}`}
              className={cn('flex px-2', line?.className)}
            >
              <span className="w-5 shrink-0 select-none text-text-muted">
                {line?.marker}
              </span>
              <span>{line?.content || ' '}</span>
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

function FileChangeRow({
  file,
  active,
  disabled,
  onOpen,
}: {
  file: TurnFileChangeItem
  active: boolean
  disabled: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('chat')

  return (
    <button
      type="button"
      data-testid="file-change-row"
      aria-expanded={active}
      disabled={disabled}
      onClick={onOpen}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60',
        active && 'bg-surface',
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-text-primary">
        {file.change_type === 'renamed' && file.old_path
          ? `${file.old_path} → ${file.path}`
          : file.path}
      </span>
      {file.binary ? (
        <span className="shrink-0 text-text-muted">
          {t('file_changes.binary_file')}
        </span>
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
}: FileChangesCardProps) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const [selectedDiffPath, setSelectedDiffPath] = useState<string>()
  const [reviewLoading, setReviewLoading] = useState(false)
  const [diff, setDiff] = useState('')
  const [reviewError, setReviewError] = useState<string>()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const hiddenCount = Math.max(
    0,
    summary.files.length - DEFAULT_VISIBLE_FILE_COUNT,
  )
  const visibleFiles = expanded
    ? summary.files
    : summary.files.slice(0, DEFAULT_VISIBLE_FILE_COUNT)
  const actionsDisabled =
    !deviceOnline || summary.status === 'artifact_missing'
  const canRevert = summary.status === 'active'

  const openFileDiff = async (file: TurnFileChangeItem) => {
    const nextPath = selectedDiffPath === file.path ? undefined : file.path
    setSelectedDiffPath(nextPath)
    if (!nextPath || file.binary) return
    if (diff || reviewLoading) return
    setReviewLoading(true)
    setReviewError(undefined)
    try {
      setDiff(await onLoadDiff(subtaskId))
    } catch (error) {
      setReviewError(
        getErrorMessage(error, t('file_changes.review_failed')),
      )
    } finally {
      setReviewLoading(false)
    }
  }

  const revert = async () => {
    setReverting(true)
    setActionError(undefined)
    try {
      await onRevert(subtaskId)
      setConfirmOpen(false)
    } catch (error) {
      setActionError(
        getErrorMessage(error, t('file_changes.revert_failed')),
      )
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
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5 text-xs font-medium text-text-primary">
          <span>{t('file_changes.edited_files_label')}</span>
          <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
        </div>
        <div className="divide-y divide-border/70">
          {visibleFiles.map(file => (
            <div key={`${file.old_path ?? ''}:${file.path}`}>
              <FileChangeRow
                file={file}
                active={selectedDiffPath === file.path}
                disabled={actionsDisabled || file.binary}
                onOpen={() => void openFileDiff(file)}
              />
              {selectedDiffPath === file.path ? (
                <InlineFileDiff
                  file={file}
                  diff={diff}
                  loading={reviewLoading}
                  error={reviewError}
                />
              ) : null}
            </div>
          ))}
        </div>
        {hiddenCount > 0 ? (
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
        className="w-full max-w-md rounded-xl border border-border bg-base p-5 shadow-2xl"
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
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
          >
            {t('file_changes.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="confirm-revert-file-changes-button"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting
              ? t('file_changes.reverting')
              : t('file_changes.confirm_revert')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
