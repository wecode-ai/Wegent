import { useState } from 'react'
import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'

export function IndependentIssueTaskButton({
  api,
  issue,
  onError,
}: {
  api: PersonalIssuesApi
  issue: IndependentIssue
  onError(message: string): void
}) {
  const workbench = useWorkbench()
  const { t } = useTranslation('common')
  const [pending, setPending] = useState(false)
  const resources = (issue.metadata.resource_participants ?? []).filter(
    resource => resource.team_id != null
  )
  const assigned = issue.metadata.assignee_resource
  const [selected, setSelected] = useState(() => {
    const target =
      resources.find(resource => resource.kind === assigned?.kind && resource.id === assigned.id) ??
      resources[0]
    return target ? target.kind + ':' + target.id : ''
  })
  const create = async () => {
    if (pending) return
    setPending(true)
    try {
      const current = await api.get(issue.id)
      const resource = current.metadata.resource_participants?.find(
        item => item.kind + ':' + item.id === selected
      )
      if (selected && !resource) throw new Error(t('independentIssues.taskFailed'))
      const processing = resource
        ? await api.processingResource(current.id, resource.kind, resource.id)
        : undefined
      if (selected && !processing?.team_id) throw new Error(t('independentIssues.taskFailed'))
      const address = await workbench.createProjectRuntimeTask(
        `${t('independentIssues.taskPrompt')}\n\n${current.title}\n\n${current.description}${processing?.instructions ? '\n\n' + processing.name + '\n' + processing.instructions : ''}`,
        {
          ...(processing?.team_id ? { wegentTeamId: processing.team_id } : {}),
          attachments: [],
          project: workbench.state.currentProject,
          deviceWorkspaceId: workbench.state.selectedDeviceWorkspaceId,
          onError,
        }
      )
      if (!address) onError(t('independentIssues.taskFailed'))
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {resources.length > 0 && (
        <select
          aria-label={t('issue_creation.process_with')}
          data-testid="independent-issue-processing-agent"
          disabled={pending}
          value={selected}
          onChange={event => setSelected(event.target.value)}
          className="min-h-11 rounded-md border border-border bg-background px-2 text-sm md:min-h-8"
        >
          {resources.map(resource => (
            <option
              key={resource.kind + ':' + resource.id}
              value={resource.kind + ':' + resource.id}
            >
              {resource.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        data-testid="independent-issue-create-task"
        disabled={pending}
        onClick={() => void create()}
        className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
      >
        {t('independentIssues.createTask')}
      </button>
    </div>
  )
}
