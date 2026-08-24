import { X } from 'lucide-react'
import type { ProjectAutomationRun } from '@/api/projectAutomations'
import type { useTranslation } from '@/hooks/useTranslation'
import { formatTimestamp, timezoneLabel } from './projectAutomationForm'

type Translate = ReturnType<typeof useTranslation>['t']

export function ProjectAutomationRunDetailDialog({
  run,
  onClose,
  t,
}: {
  run: ProjectAutomationRun
  onClose: () => void
  t: Translate
}) {
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-automation-run-detail-title"
        data-testid="project-automation-run-detail-dialog"
        className="w-full max-w-xl rounded-[20px] border border-border bg-popover p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="project-automation-run-detail-title" className="heading-small">
              {t('workbench.project_automation_run_details')}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              {formatTimestamp(run.scheduledFor, run.timezone)} · {timezoneLabel(run.timezone, t)}
            </p>
          </div>
          <button
            type="button"
            data-testid="project-automation-run-detail-close"
            aria-label={t('workbench.close')}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-surface"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface p-4 text-code text-text-primary">
          {run.error || t('workbench.project_automation_run_succeeded')}
        </pre>
      </div>
    </div>
  )
}
