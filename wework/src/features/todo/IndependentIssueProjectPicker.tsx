import { useEffect, useState } from 'react'
import type { CloudProject } from '@/api/deliveries'
import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import { useTranslation } from '@/hooks/useTranslation'

export function IndependentIssueProjectPicker({
  api,
  issue,
  busy,
  onConfirm,
  onCancel,
}: {
  api: PersonalIssuesApi
  issue: IndependentIssue
  busy: boolean
  onConfirm(projectId: string, status: string): void
  onCancel(): void
}) {
  const { t } = useTranslation('common')
  const [projects, setProjects] = useState<CloudProject[]>([])
  const [selected, setSelected] = useState('')
  const [targetStatus, setTargetStatus] = useState('')
  const statuses =
    projects.find(project => String(project.id) === selected)?.board_config?.statuses ?? []
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    void api.projects().then(
      page => {
        if (active) {
          setProjects(
            page.items.filter(project => ['local', 'backend'].includes(project.task_provider))
          )
          setError('')
        }
      },
      reason => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      }
    )
    return () => {
      active = false
    }
  }, [api, revision])
  return (
    <section
      className="mb-5 grid gap-3 rounded-md border border-border p-4"
      aria-label={t('independentIssues.attachProject')}
    >
      <h3 className="text-base font-medium">{t('independentIssues.attachProject')}</h3>
      <p className="text-sm text-text-secondary">{t('independentIssues.attachHint')}</p>
      {error ? (
        <div role="alert" className="text-sm text-error">
          {error}
          <button
            type="button"
            data-testid="independent-issue-project-retry"
            className="min-h-11 px-3 underline md:min-h-8"
            onClick={() => setRevision(value => value + 1)}
          >
            {t('independentIssues.retry')}
          </button>
        </div>
      ) : null}
      <label className="grid gap-2 text-sm">
        {t('independentIssues.chooseProject')}
        <select
          data-testid="independent-issue-project"
          value={selected}
          disabled={busy}
          onChange={event => {
            const project = projects.find(item => String(item.id) === event.target.value)
            setSelected(event.target.value)
            setTargetStatus(
              project?.board_config?.statuses.some(status => status.id === issue.status)
                ? issue.status
                : ''
            )
          }}
          className="min-h-11 rounded-md border border-border bg-background px-3 md:min-h-8"
        >
          <option value="">{t('independentIssues.chooseProject')}</option>
          {projects.map(project => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {selected ? (
        <label className="grid gap-2 text-sm">
          {t('independentIssues.projectStatus')}
          <select
            data-testid="independent-issue-project-status"
            value={targetStatus}
            disabled={busy}
            onChange={event => setTargetStatus(event.target.value)}
            className="min-h-11 rounded-md border border-border bg-background px-3 md:min-h-8"
          >
            <option value="">
              {t(
                statuses.length ? 'independentIssues.projectStatus' : 'independentIssues.noStatus'
              )}
            </option>
            {statuses.map(status => (
              <option key={status.id} value={status.id}>
                {status.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          data-testid="independent-issue-project-cancel"
          onClick={onCancel}
          className="min-h-11 rounded-md border border-border px-3 md:min-h-8"
        >
          {t('independentIssues.cancel')}
        </button>
        <button
          type="button"
          disabled={busy || !selected || (statuses.length > 0 && !targetStatus) || !issue.id}
          data-testid="independent-issue-project-confirm"
          onClick={() => onConfirm(selected, targetStatus)}
          className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
        >
          {t('independentIssues.confirmAttach')}
        </button>
      </div>
    </section>
  )
}
