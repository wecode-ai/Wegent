import type { CollaborationProject, WorkspaceRuntimeTaskAddress } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { toRuntimeTaskAddress } from '@/features/collaboration/weworkSharedWorkspaceApi'
import type { IssueRuntimeBindingPort } from './useIssuePersonalTaskConversation'

export function issueRuntimeBindingPort(
  services: Pick<WorkbenchServices, 'projectSpaceApis' | 'workspaceRuntimePort'>,
  store: CollaborationProject['project_store']
): IssueRuntimeBindingPort | undefined {
  if (store !== 'local') return services.workspaceRuntimePort
  const local = services.projectSpaceApis?.local
  if (!local) return undefined
  return {
    bindTask: (
      issueId: string,
      task: WorkspaceRuntimeTaskAddress,
      title?: string | null,
      dispatch?: {
        humanAssignmentId: string
        dispatchId: string
        dispatchRoundId: string
        assignmentId: string
      } | null
    ) => local.bindTask(issueId, toRuntimeTaskAddress(task), title, null, dispatch),
    unbindTask: (issueId, task) => local.unbindTask(issueId, toRuntimeTaskAddress(task)),
  }
}
