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
import { useState } from 'react'
import type { IndependentIssueDialogProps } from '@wegent/collaboration/platform'
import { AiChatModal } from './AiChatModal'
import { IssueExistingTaskAction } from './IssueExistingTaskAction'
import { prepareIssueRuntimeTask } from './prepareIssueRuntimeTask'

export function useIndependentIssueTaskActions(
  api: PersonalIssuesApi
): IndependentIssueDialogProps['taskActions'] {
  const workbench = useWorkbench()
  const { t } = useTranslation('common')
  const [selection, setSelection] = useState<{ issueId: string; resource: string }>()
  const port = workbench.services.workspaceRuntimePort
  if (!port) return undefined

  const resourceKey = (resource: { kind: string; id: number }) => resource.kind + ':' + resource.id
  function selectedResource(issue: IndependentIssue) {
    const resources = (issue.metadata.resource_participants ?? []).filter(
      resource => resource.team_id != null
    )
    const assigned = issue.metadata.assignee_resource
    const preferred =
      resources.find(resource => resource.kind === assigned?.kind && resource.id === assigned.id) ??
      resources[0]
    return {
      resources,
      selected:
        selection?.issueId === issue.id &&
        resources.some(row => resourceKey(row) === selection.resource)
          ? selection.resource
          : preferred
            ? resourceKey(preferred)
            : '',
    }
  }

  return {
    list: workbench.services.sharedWorkspaceApi?.taskBindings.list,
    link: (issue, refresh) => bindings => {
      const { resources, selected } = selectedResource(issue)
      return (
        <>
          {resources.length > 1 && (
            <SelectRoot
              value={normalizeSelectValue(selected)}
              onValueChange={resource => {
                if (resource !== null) setSelection({ issueId: issue.id, resource })
              }}
            >
              <SelectTrigger
                density="compact"
                aria-label={t('issue_creation.process_with')}
                data-testid="independent-issue-processing-agent"
              />
              <SelectContent>
                {resources.map(resource => (
                  <SelectItem key={resourceKey(resource)} value={resourceKey(resource)}>
                    {resource.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
          )}
          <IssueExistingTaskAction
            source={{ work: workbench.state.runtimeWork, port }}
            issue={issue}
            bindings={bindings}
            onLinked={refresh}
          />
        </>
      )
    },
    renderConversation(issue, task, close, refresh) {
      const { resources, selected } = selectedResource(issue)
      const resource = resources.find(item => resourceKey(item) === selected)
      const execution = task?.executionContext
      return (
        <AiChatModal
          key={task?.id ?? issue.id}
          open
          embedded
          task={issue}
          localProjects={workbench.state.projects}
          initialTaskInput={[issue.title, issue.description].filter(Boolean).join('\n\n')}
          initialAddress={
            task
              ? {
                  deviceId: task.device_id,
                  taskId: task.task_id,
                  runtime: execution?.runtime ?? undefined,
                  threadId: execution?.threadId,
                  workspacePath: execution?.workspacePath,
                  workspaceKind: execution?.workspaceKind,
                  worktreeId: execution?.worktreeId,
                }
              : null
          }
          onOpenRuntimeTask={workbench.openRuntimeTask}
          onClose={close}
          onTaskCreated={refresh}
          prepareTask={address =>
            prepareIssueRuntimeTask({ port, address, issueId: issue.id, title: issue.title })
          }
          resolveTaskInput={
            resource
              ? async message => {
                  const processing = await api.processingResource(
                    issue.id,
                    resource.kind,
                    resource.id
                  )
                  if (!processing.team_id) throw new Error(t('independentIssues.taskFailed'))
                  return {
                    message: processing.instructions
                      ? [message, processing.name, processing.instructions].join('\n\n')
                      : message,
                    wegentTeamId: processing.team_id,
                  }
                }
              : undefined
          }
        />
      )
    },
  }
}
