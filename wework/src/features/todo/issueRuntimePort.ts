import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { CollaborationProject, WorkspaceRuntimeTaskAddress } from '@wegent/collaboration'
import { toRuntimeTaskAddress } from '@/features/collaboration/weworkSharedWorkspaceApi'

export function issueRuntimePort(
  projectStore: CollaborationProject['project_store'],
  services: WorkbenchServices
) {
  const localDeliveryApi = services.projectSpaceApis?.local
  return projectStore === 'local' && localDeliveryApi
    ? {
        bindTask: (
          issueId: string,
          task: WorkspaceRuntimeTaskAddress,
          taskTitle?: string | null,
          dispatch?: {
            humanAssignmentId: string
            dispatchId: string
            dispatchRoundId: string
            assignmentId: string
          } | null
        ) =>
          localDeliveryApi.bindTask(issueId, toRuntimeTaskAddress(task), taskTitle, null, dispatch),
        unbindTask: (issueId: string, task: WorkspaceRuntimeTaskAddress) =>
          localDeliveryApi.unbindTask(issueId, toRuntimeTaskAddress(task)),
      }
    : services.workspaceRuntimePort
}
