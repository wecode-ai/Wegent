import { invoke } from '@tauri-apps/api/core'
import { Check, CircleAlert, FileArchive, Loader2, Send, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

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

interface FeedbackSubmitResult {
  report_id: string
  item_id: string
  duplicate: boolean
}

interface FeedbackApi {
  submit(input: {
    reportId: string
    title: string
    description: string
    context: Record<string, unknown>
    bundlePath: string
  }): Promise<FeedbackSubmitResult>
}

interface TaskFeedbackDialogProps {
  open: boolean
  getTaskContext: () => Promise<Record<string, unknown>>
  feedbackApi?: FeedbackApi
  onClose: () => void
}

const initialSelection: FeedbackSelection = {
  runtimeLogs: true,
  taskInfo: true,
  screenshot: true,
  systemInfo: true,
}

export function TaskFeedbackDialog({
  open,
  getTaskContext,
  feedbackApi,
  onClose,
}: TaskFeedbackDialogProps) {
  if (!open) return null
  return (
    <TaskFeedbackDialogContent
      getTaskContext={getTaskContext}
      feedbackApi={feedbackApi}
      onClose={onClose}
    />
  )
}

function TaskFeedbackDialogContent({
  getTaskContext,
  feedbackApi,
  onClose,
}: Omit<TaskFeedbackDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const [selection, setSelection] = useState(initialSelection)
  const [note, setNote] = useState('')
  const [exporting, setExporting] = useState(false)
  const [capturingScreenshot, setCapturingScreenshot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FeedbackExportResult | null>(null)
  const [submitted, setSubmitted] = useState<FeedbackSubmitResult | null>(null)
  const [pendingBundle, setPendingBundle] = useState<{
    exported: FeedbackExportResult
    context: Record<string, unknown>
  } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const hasSelection = Object.values(selection).some(Boolean)

  const closeDialog = () => {
    if (pendingBundle) {
      void invoke('discard_feedback_bundle', { path: pendingBundle.exported.path })
    }
    onClose()
  }

  useEscapeKey(exporting ? () => undefined : closeDialog)

  const createBundle = async (saveToDownloads: boolean) => {
    const taskContext = selection.taskInfo ? await getTaskContext() : {}
    let screenshotDataUrl: string | null = null
    if (selection.screenshot) {
      const overlay = overlayRef.current
      overlay?.style.setProperty('visibility', 'hidden')
      setCapturingScreenshot(true)
      await waitForScreenshotPaint()
      try {
        screenshotDataUrl = await invoke<string>('capture_main_webview')
      } catch {
        screenshotDataUrl = null
      } finally {
        overlay?.style.removeProperty('visibility')
        setCapturingScreenshot(false)
      }
    }
    const exported = await invoke<FeedbackExportResult>('export_feedback_bundle', {
      request: {
        destination: null,
        includeRuntimeLogs: selection.runtimeLogs,
        includeTaskInfo: selection.taskInfo,
        includeScreenshot: selection.screenshot,
        includeSystemInfo: selection.systemInfo,
        note,
        taskContext: selection.taskInfo ? taskContext : null,
        screenshotDataUrl,
        saveToDownloads,
      },
    })
    return { exported, context: taskContext }
  }

  const exportBundle = async () => {
    setExporting(true)
    setError(null)
    try {
      const bundle = await createBundle(true)
      setResult(bundle.exported)
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

  const submitFeedback = async () => {
    setExporting(true)
    setError(null)
    let reportId = pendingBundle?.exported.reportId ?? null
    try {
      if (!feedbackApi) throw new Error(t('workbench.feedback_channel_unavailable'))
      const bundle = pendingBundle ?? (await createBundle(false))
      reportId = bundle.exported.reportId
      setPendingBundle(bundle)
      const task = bundle.context.task
      const taskTitle =
        task && typeof task === 'object' && 'title' in task && typeof task.title === 'string'
          ? task.title
          : ''
      const response = await feedbackApi.submit({
        reportId: bundle.exported.reportId,
        title: note.trim().split('\n')[0] || taskTitle || t('workbench.feedback_default_title'),
        description: note.trim(),
        context: bundle.context,
        bundlePath: bundle.exported.path,
      })
      setSubmitted(response)
      setPendingBundle(null)
    } catch {
      setError(
        reportId
          ? t('workbench.feedback_contact_developer_with_report', { reportId })
          : t('workbench.feedback_contact_developer')
      )
    } finally {
      setExporting(false)
    }
  }

  return createPortal(
    <div
      ref={overlayRef}
      data-testid="task-feedback-dialog-overlay"
      aria-hidden={capturingScreenshot || undefined}
      className={cn(
        'fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4',
        capturingScreenshot && 'invisible'
      )}
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
            onClick={closeDialog}
            disabled={exporting}
            className="flex h-8 min-w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.close_dialog')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {submitted ? (
          <div className="mt-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Check className="h-4 w-4 text-success" />
              {t('workbench.feedback_submitted')}
            </div>
            <p className="mt-2 text-sm text-text-secondary">
              {t('workbench.feedback_board_item')}: {submitted.item_id}
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              {t('workbench.feedback_report_id')}: {submitted.report_id}
            </p>
          </div>
        ) : result ? (
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
                    onChange={event => {
                      setPendingBundle(null)
                      setSelection(current => ({ ...current, [key]: event.target.checked }))
                    }}
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
                onChange={event => {
                  setPendingBundle(null)
                  setNote(event.target.value)
                }}
                placeholder={t('workbench.feedback_note_placeholder')}
                rows={3}
                className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>
            <p className="mt-3 text-xs text-text-secondary">
              {t('workbench.feedback_privacy_notice')}
            </p>
          </>
        )}

        {error ? (
          <div
            data-testid="task-feedback-error"
            role="status"
            className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/60 px-3 py-2 text-xs text-text-secondary"
          >
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid="task-feedback-cancel-button"
            onClick={closeDialog}
            disabled={exporting}
            className="h-9 rounded-md px-3 text-sm font-medium hover:bg-muted"
          >
            {result || submitted ? t('workbench.feedback_close') : t('workbench.cancel')}
          </button>
          {!result && !submitted ? (
            <button
              type="button"
              data-testid="task-feedback-export-button"
              disabled={!hasSelection || exporting}
              onClick={() => void exportBundle()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-muted px-3 text-sm font-medium hover:bg-muted/80 disabled:opacity-50"
            >
              <FileArchive className="h-4 w-4" />
              {t('workbench.feedback_export_only')}
            </button>
          ) : null}
          {!result && !submitted ? (
            <button
              type="button"
              data-testid="task-feedback-submit-button"
              disabled={!hasSelection || exporting}
              onClick={() => void submitFeedback()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {t('workbench.feedback_submit')}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}

function waitForScreenshotPaint(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 500))
}
