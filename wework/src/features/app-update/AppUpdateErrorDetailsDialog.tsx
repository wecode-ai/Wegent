import { Check, Copy, Loader2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import type { AppUpdateError } from './app-update-error'
import {
  formatAppUpdateErrorFeature,
  formatAppUpdateErrorSummary,
  formatAppUpdateErrorType,
} from './app-update-error-copy'

interface AppUpdateErrorDetailsDialogProps {
  open: boolean
  error: AppUpdateError
  onClose: () => void
  onRetry: () => Promise<void>
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function AppUpdateErrorDetailsDialog({
  open,
  error,
  onClose,
  onRetry,
}: AppUpdateErrorDetailsDialogProps) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')
  const [retrying, setRetrying] = useState(false)
  const summary = formatAppUpdateErrorSummary(error, t)
  const errorType = formatAppUpdateErrorType(error.kind, t)
  const affectedFeature = formatAppUpdateErrorFeature(error.stage, t)
  const occurredAt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(new Date(error.occurredAt)),
    [error.occurredAt]
  )
  const diagnostics = useMemo(
    () =>
      [
        `${t('workbench.app_update_error_type', '错误类型')}: ${errorType}`,
        `${t('workbench.app_update_error_code', '错误代码')}: ${error.code}`,
        `${t('workbench.app_update_error_time', '发生时间')}: ${occurredAt}`,
        `${t('workbench.app_update_error_affected_feature', '影响功能')}: ${affectedFeature}`,
        error.detail
          ? `${t('workbench.app_update_error_technical_detail', '技术信息')}: ${error.detail}`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    [affectedFeature, error.code, error.detail, errorType, occurredAt, t]
  )

  useEscapeKey(onClose, open && !retrying)

  useEffect(() => {
    if (!open) return

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())

    return () => {
      window.cancelAnimationFrame(frame)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [error, open])

  if (!open) return null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
    )
    if (focusable.length === 0) return
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex === focusable.length - 1
        ? 0
        : currentIndex + 1
    event.preventDefault()
    focusable[nextIndex]?.focus()
  }

  const retryLabel =
    error.kind === 'network'
      ? t('workbench.app_update_error_reconnect', '重新连接')
      : t('common.retry', '重试')

  return createPortal(
    <div
      data-testid="app-update-error-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (event.target === event.currentTarget && !retrying) onClose()
      }}
    >
      <div
        ref={dialogRef}
        data-testid="app-update-error-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-error-dialog-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="relative w-full max-w-[420px] rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
      >
        <button
          ref={closeButtonRef}
          type="button"
          data-testid="app-update-error-dialog-close"
          disabled={retrying}
          onClick={onClose}
          aria-label={t('common.close', '关闭')}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-45"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="flex items-start gap-3 pr-10">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:text-orange-400">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="app-update-error-dialog-title" className="text-lg font-medium">
              {t('workbench.app_update_error_dialog_title', '应用更新失败')}
            </h2>
            <p className="mt-1 text-sm leading-5 text-text-secondary">{summary}</p>
          </div>
        </div>

        <dl className="mt-5 space-y-3 rounded-lg bg-muted/60 p-3 text-sm">
          <ErrorDetailRow
            label={t('workbench.app_update_error_type', '错误类型')}
            value={errorType}
          />
          <ErrorDetailRow
            label={t('workbench.app_update_error_code', '错误代码')}
            value={error.code}
            code
          />
          <ErrorDetailRow
            label={t('workbench.app_update_error_time', '发生时间')}
            value={occurredAt}
          />
          <ErrorDetailRow
            label={t('workbench.app_update_error_affected_feature', '影响功能')}
            value={affectedFeature}
          />
          {error.detail ? (
            <ErrorDetailRow
              label={t('workbench.app_update_error_technical_detail', '技术信息')}
              value={error.detail}
              code
            />
          ) : null}
        </dl>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-testid="app-update-error-copy"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(diagnostics)
                .then(() => setCopyState('copied'))
                .catch(() => undefined)
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted"
          >
            {copyState === 'copied' ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copyState === 'copied'
              ? t('workbench.app_update_error_copied', '已复制')
              : t('workbench.app_update_error_copy', '复制诊断信息')}
          </button>
          <button
            type="button"
            data-testid="app-update-error-retry"
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              void onRetry().finally(() => setRetrying(false))
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {retrying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {retryLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ErrorDetailRow({
  label,
  value,
  code = false,
}: {
  label: string
  value: string
  code?: boolean
}) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd
        className={
          code
            ? 'break-words font-mono text-code text-text-primary'
            : 'break-words text-text-primary'
        }
      >
        {value}
      </dd>
    </div>
  )
}
