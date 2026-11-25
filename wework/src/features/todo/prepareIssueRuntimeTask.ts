import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WeworkWorkspaceRuntimePort,
} from '@wegent/collaboration'
import type { RuntimeTaskAddress } from '@/types/api'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'
import { prepareIssueStartStatus } from './workItemTaskInput'

/** Bind before execution starts; undo the binding if the runtime rejects the send. */
export async function prepareIssueRuntimeTask({
  port,
  project,
  issueId,
  title,
  address,
  dispatch,
  dispatchRoundId,
  issues,
  onStatusError,
}: {
  port: Pick<WeworkWorkspaceRuntimePort, 'bindTask' | 'unbindTask'>
  issueId: string
  title: string
  address: RuntimeTaskAddress
  dispatch?: Parameters<WeworkWorkspaceRuntimePort['bindTask']>[3]
  dispatchRoundId?: string | null
} & (
  | {
      project: CollaborationProject
      issues: Pick<SharedWorkspaceApi['issues'], 'get' | 'update'>
      onStatusError(error: string): void
    }
  | { project?: undefined; issues?: undefined; onStatusError?: undefined }
)) {
  const task = toWorkspaceRuntimeTaskAddress(address)
  await port.bindTask(issueId, task, title, dispatch)
  if (!project) return () => port.unbindTask(issueId, task)
  const projectRef = { projectStore: project.project_store, projectId: String(project.id) }
  publishProjectSpaceTaskBindingChanged({ task: address, project: projectRef, type: 'bound' })
  const status = await prepareIssueStartStatus(issues, issueId, {
    projectStore: project.project_store,
    dispatchRoundId: dispatchRoundId ?? dispatch?.dispatchRoundId,
  })
  if (status.error !== null) onStatusError(status.error)
  return async () => {
    try {
      await status.rollback?.()
    } finally {
      await port.unbindTask(issueId, task)
      publishProjectSpaceTaskBindingChanged({ task: address, project: projectRef, type: 'unbound' })
    }
  }
}
