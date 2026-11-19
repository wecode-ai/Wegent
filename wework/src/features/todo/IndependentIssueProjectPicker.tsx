import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import { useTranslation } from '@/hooks/useTranslation'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { usePanelData } from '@wegent/collaboration/platform'
import { useCallback, useState } from 'react'
import { IssueProjectSelect } from './IssueProjectSelect'

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
  const loadProjects = useCallback(() => api.projects(), [api])
  const { data, error, loading, refresh } = usePanelData(loadProjects)
  const projects = (data?.items ?? []).filter(project =>
    ['local', 'backend'].includes(project.task_provider)
  )
  const [selected, setSelected] = useState('')
  const [targetStatus, setTargetStatus] = useState('')
  const statuses =
    projects.find(project => String(project.id) === selected)?.board_config?.statuses ?? []
  return (
    <section
      className="mb-5 grid gap-3 rounded-md border border-border p-4"
      aria-label={t('independentIssues.attachProject')}
    >
      <h3 className="text-base font-medium">{t('independentIssues.attachProject')}</h3>
      <p className="text-sm text-text-secondary">{t('independentIssues.attachHint')}</p>
      {loading && (
        <p
          role="status"
          data-testid="issue-project-loading"
          className="text-sm text-text-secondary"
        >
          {t('issue_creation.projects_loading')}
        </p>
      )}
      {error !== undefined ? (
        <div role="alert" className="text-sm text-destructive">
          {t('issue_creation.projects_load_failed')}
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="independent-issue-project-retry"
            className="min-h-11 px-3 underline md:min-h-8"
            onClick={() => void refresh()}
          >
            {t('independentIssues.retry')}
          </ControlButton>
        </div>
      ) : null}
      <label className="grid gap-2 text-sm">
        {t('independentIssues.chooseProject')}
        <IssueProjectSelect
          projects={projects}
          value={selected}
          disabled={busy || loading}
          placeholder={t('independentIssues.chooseProject')}
          onChange={value => {
            const project = projects.find(item => String(item.id) === value)
            setSelected(value)
            setTargetStatus(
              project?.board_config?.statuses.some(status => status.id === issue.status)
                ? issue.status
                : ''
            )
          }}
        />
      </label>
      {selected ? (
        <label className="grid gap-2 text-sm">
          {t('independentIssues.projectStatus')}
          <SelectRoot
            value={normalizeSelectValue(targetStatus)}
            disabled={busy}
            onValueChange={selectedValue => {
              if (selectedValue !== null) return setTargetStatus(selectedValue)
            }}
          >
            <SelectTrigger density="compact" data-testid="independent-issue-project-status" />
            <SelectContent>
              <SelectItem value="">
                {t(
                  statuses.length ? 'independentIssues.projectStatus' : 'independentIssues.noStatus'
                )}
              </SelectItem>
              {statuses.map(status => (
                <SelectItem key={status.id} value={String(status.id)}>
                  {status.name}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectRoot>
        </label>
      ) : null}
      <div className="flex justify-end gap-2">
        <ControlButton
          variant="outline"
          size="sm"
          type="button"
          disabled={busy}
          data-testid="independent-issue-project-cancel"
          onClick={onCancel}
          className="min-h-11 rounded-md border border-border px-3 md:min-h-8"
        >
          {t('independentIssues.cancel')}
        </ControlButton>
        <ControlButton
          variant="primary"
          size="sm"
          type="button"
          disabled={busy || !selected || (statuses.length > 0 && !targetStatus) || !issue.id}
          data-testid="independent-issue-project-confirm"
          onClick={() => onConfirm(selected, targetStatus)}
          className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
        >
          {t('independentIssues.confirmAttach')}
        </ControlButton>
      </div>
    </section>
  )
}
