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
  const create = async () => {
    if (pending) return
    setPending(true)
    try {
      const current = await api.get(issue.id)
      const address = await workbench.createProjectRuntimeTask(
        `${t('independentIssues.taskPrompt')}\n\n${current.title}\n\n${current.description}`,
        {
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
    <button
      type="button"
      data-testid="independent-issue-create-task"
      disabled={pending}
      onClick={() => void create()}
      className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
    >
      {t('independentIssues.createTask')}
    </button>
  )
}
