import { invoke } from '@tauri-apps/api/core'
import { Check, FileArchive, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'

interface FeedbackSelection {
  runtimeLogs: boolean
  taskInfo: boolean
  screenshot: boolean
  systemInfo: boolean
}

interface FeedbackExportResult {
  reportId: string
  path: string
}

interface TaskFeedbackDialogProps {
  open: boolean
  taskContext: Record<string, unknown>
  onClose: () => void
}

const initialSelection: FeedbackSelection = {
  runtimeLogs: true,
  taskInfo: true,
  screenshot: true,
  systemInfo: true,
}

export function TaskFeedbackDialog({ open, taskContext, onClose }: TaskFeedbackDialogProps) {
  if (!open) return null
  return <TaskFeedbackDialogContent taskContext={taskContext} onClose={onClose} />
}

function TaskFeedbackDialogContent({
  taskContext,
  onClose,
}: Omit<TaskFeedbackDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const [selection, setSelection] = useState(initialSelection)
  const [note, setNote] = useState('')
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FeedbackExportResult | null>(null)
  const hasSelection = Object.values(selection).some(Boolean)

  useEscapeKey(exporting ? () => undefined : onClose)

  const exportBundle = async () => {
    setExporting(true)
    setError(null)
    try {
      const screenshotDataUrl = selection.screenshot
        ? await invoke<string>('capture_main_webview').catch(() => null)
        : null
      const exported = await invoke<FeedbackExportResult>('export_feedback_bundle', {
        request: {
          destination: null,
          includeRuntimeLogs: selection.runtimeLogs,
          includeTaskInfo: selection.taskInfo,
          includeScreenshot: selection.screenshot,
          includeSystemInfo: selection.systemInfo,
          note,
          taskContext,
          screenshotDataUrl,
        },
      })
      setResult(exported)
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError || t('workbench.feedback_export_failed'))
      )
    } finally {
      setExporting(false)
    }
  }

  return createPortal(
    <div
      data-testid="task-feedback-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-feedback-dialog-title"
        className="w-full max-w-[440px] rounded-xl border border-border bg-popover p-5 text-text-primary shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="task-feedback-dialog-title" className="heading-sm">
              {t('workbench.feedback_title')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t('workbench.feedback_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="task-feedback-close-button"
            onClick={onClose}
            disabled={exporting}
            className="flex h-8 min-w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.cancel')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          <div className="mt-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Check className="h-4 w-4 text-success" />
              {t('workbench.feedback_exported')}
            </div>
            <p className="mt-2 break-all text-xs text-text-secondary">{result.path}</p>
            <p className="mt-1 text-xs text-text-secondary">
              {t('workbench.feedback_report_id')}: {result.reportId}
            </p>
          </div>
        ) : (
          <>
            <div className="mt-5 space-y-1">
              {(
                [
                  ['runtimeLogs', 'feedback_runtime_logs', 'feedback_runtime_logs_description'],
                  ['taskInfo', 'feedback_task_info', 'feedback_task_info_description'],
                  ['screenshot', 'feedback_screenshot', 'feedback_screenshot_description'],
                  ['systemInfo', 'feedback_system_info', 'feedback_system_info_description'],
                ] as const
              ).map(([key, label, description]) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted"
                >
                  <input
                    data-testid={`task-feedback-${key}-checkbox`}
                    type="checkbox"
                    checked={selection[key]}
                    onChange={event =>
                      setSelection(current => ({ ...current, [key]: event.target.checked }))
                    }
                    className="mt-0.5 h-4 w-4 accent-current"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t(`workbench.${label}`)}</span>
                    <span className="block text-xs text-text-secondary">
                      {t(`workbench.${description}`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <label className="mt-4 block text-sm font-medium">
              {t('workbench.feedback_note')}
              <textarea
                data-testid="task-feedback-note"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder={t('workbench.feedback_note_placeholder')}
                rows={3}
                className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>
          </>
        )}

        {error ? <p className="mt-3 text-xs text-red-500">{error}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid="task-feedback-cancel-button"
            onClick={onClose}
            disabled={exporting}
            className="h-9 rounded-md px-3 text-sm font-medium hover:bg-muted"
          >
            {result ? t('workbench.feedback_close') : t('workbench.cancel')}
          </button>
          {!result ? (
            <button
              type="button"
              data-testid="task-feedback-export-button"
              disabled={!hasSelection || exporting}
              onClick={() => void exportBundle()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileArchive className="h-4 w-4" />
              )}
              {t('workbench.feedback_export')}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
