import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useState } from 'react'

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
  const [selection, setSelected] = useState('')
  const preferred =
    resources.find(resource => resource.kind === assigned?.kind && resource.id === assigned.id) ??
    resources[0]
  const selected = resources.some(resource => resource.kind + ':' + resource.id === selection)
    ? selection
    : preferred
      ? preferred.kind + ':' + preferred.id
      : ''
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
        <SelectRoot
          disabled={pending}
          value={normalizeSelectValue(selected)}
          onValueChange={selectedValue => {
            if (selectedValue !== null) return setSelected(selectedValue)
          }}
        >
          <SelectTrigger
            density="compact"
            aria-label={t('issue_creation.process_with')}
            data-testid="independent-issue-processing-agent"
          />
          <SelectContent>
            {resources.map(resource => (
              <SelectItem
                key={resource.kind + ':' + resource.id}
                value={String(resource.kind + ':' + resource.id)}
              >
                {resource.name}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
      )}
      <ControlButton
        variant="outline"
        size="sm"
        type="button"
        data-testid="independent-issue-create-task"
        disabled={pending}
        onClick={() => void create()}
        className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
      >
        {t('independentIssues.createTask')}
      </ControlButton>
    </div>
  )
}
