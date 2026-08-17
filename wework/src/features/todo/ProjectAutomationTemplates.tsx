import { ClipboardList, Sparkles } from 'lucide-react'
import {
  DEFAULT_AI_MANAGED_PROMPT_KEY,
  type ProjectAutomationTemplate,
} from './projectAutomationForm'

interface ProjectAutomationTemplatesProps {
  canManage: boolean
  onSelect: (template: ProjectAutomationTemplate) => void
  t: (key: string) => string
}

const templateButtonClass =
  'flex min-h-20 items-center gap-3.5 rounded-xl border border-border bg-background p-4 text-left transition hover:border-text-tertiary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30'

export function ProjectAutomationTemplates({
  canManage,
  onSelect,
  t,
}: ProjectAutomationTemplatesProps) {
  return (
    <div className="mt-5 flex min-h-40 flex-col justify-center rounded-2xl border border-dashed border-border p-5">
      {canManage ? (
        <div>
          <p className="mb-2.5 text-xs font-medium text-text-muted">
            {t('workbench.project_templates_start')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <button
              type="button"
              data-testid="project-automation-template-board-managed"
              onClick={() =>
                onSelect({
                  name: t('workbench.project_automation_template_board_managed_name'),
                  prompt: t(DEFAULT_AI_MANAGED_PROMPT_KEY),
                  triggerType: 'event',
                  eventType: 'task.created',
                  assignmentMode: 'ai_managed',
                  managerType: 'custom',
                  agentId: null,
                })
              }
              className={templateButtonClass}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Sparkles className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text-primary">
                  {t('workbench.project_automation_template_board_managed_name')}
                </span>
                <span className="mt-1 block truncate text-xs text-text-muted">
                  {t('workbench.project_automation_template_board_managed_description')}
                </span>
              </span>
            </button>
            <button
              type="button"
              data-testid="project-automation-template-daily-progress"
              onClick={() =>
                onSelect({
                  name: t('workbench.project_automation_template_daily_progress_name'),
                  prompt: t('workbench.project_automation_template_daily_progress_prompt'),
                  schedule: { frequency: 'weekdays', time: '18:00', weekday: '1' },
                })
              }
              className={templateButtonClass}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <ClipboardList className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text-primary">
                  {t('workbench.project_automation_template_daily_progress_name')}
                </span>
                <span className="mt-1 block truncate text-xs text-text-muted">
                  {t('workbench.project_automation_template_daily_progress_description')}
                </span>
              </span>
            </button>
            <button
              type="button"
              data-testid="project-automation-template-task-triage"
              onClick={() =>
                onSelect({
                  name: t('workbench.project_automation_template_task_triage_name'),
                  prompt: t('workbench.project_automation_template_task_triage_prompt'),
                  schedule: { frequency: 'daily', time: '09:00', weekday: '1' },
                })
              }
              className={templateButtonClass}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Sparkles className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text-primary">
                  {t('workbench.project_automation_template_task_triage_name')}
                </span>
                <span className="mt-1 block truncate text-xs text-text-muted">
                  {t('workbench.project_automation_template_task_triage_description')}
                </span>
              </span>
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-muted">{t('workbench.project_automation_empty')}</p>
      )}
    </div>
  )
}
