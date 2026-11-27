import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Check, Copy, Loader2, TriangleAlert, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

export function AppUpdateErrorDetailsDialog({
  open,
  error,
  onClose,
  onRetry,
}: AppUpdateErrorDetailsDialogProps) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
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

  if (!open) return null

  const retryLabel =
    error.kind === 'network' && error.stage !== 'prepare'
      ? t('workbench.app_update_error_reconnect', '重新连接')
      : t('common.retry', '重试')
  const copyLabel = {
    idle: t('workbench.app_update_error_copy', '复制诊断信息'),
    copying: t('workbench.app_update_error_copying', '复制中'),
    copied: t('workbench.app_update_error_copied', '已复制'),
    failed: t('workbench.app_update_error_copy_failed', '复制失败，请重试'),
  }[copyState]

  return createPortal(
    <div
      data-testid="app-update-error-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (event.target === event.currentTarget && !retrying) onClose()
      }}
    >
      <DialogSurface
        initialFocus={() => closeButtonRef.current}
        onClose={() => {
          if (open && !retrying) onClose()
        }}
        render={
          <div
            ref={dialogRef}
            data-testid="app-update-error-dialog"
            aria-labelledby="app-update-error-dialog-title"
            tabIndex={-1}
            className="relative w-full max-w-[420px] rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
          />
        }
      >
        <ControlButton
          variant="unstyled"
          ref={closeButtonRef}
          type="button"
          data-testid="app-update-error-dialog-close"
          disabled={retrying}
          onClick={onClose}
          aria-label={t('common.close', '关闭')}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-45"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </ControlButton>

        <div className="flex items-start gap-3 pr-10">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning wework:bg-orange-500/10 wework:text-orange-600 wework:dark:text-orange-400">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="app-update-error-dialog-title" className="text-lg font-medium">
              {t('workbench.app_update_error_dialog_title', '应用更新失败')}
            </h2>
            <p className="mt-1 text-sm leading-5 text-text-secondary">{summary}</p>
            {['extract', 'verify', 'prepare'].includes(error.stage) ? (
              <p className="mt-1 text-sm leading-5 text-text-secondary">
                {t('workbench.app_update_keep_current_version')}
              </p>
            ) : null}
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
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid="app-update-error-copy"
            disabled={copyState === 'copying'}
            aria-busy={copyState === 'copying'}
            aria-live="polite"
            onClick={() => {
              setCopyState('copying')
              void copyTextToClipboard(diagnostics)
                .then(() => setCopyState('copied'))
                .catch(() => setCopyState('failed'))
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
          >
            {copyState === 'copying' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : copyState === 'copied' ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copyLabel}
          </ControlButton>
          {error.retryable !== false ? (
            <ControlButton
              variant="primary"
              size="sm"
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
            </ControlButton>
          ) : null}
        </div>
      </DialogSurface>
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
