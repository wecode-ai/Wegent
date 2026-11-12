import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WeworkWorkspaceRuntimePort,
} from '@wegent/collaboration'
import type { RuntimeTaskAddress } from '@/types/api'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'
import { updateIssueWhenPersonalTaskStarts } from './workItemTaskInput'

/** Bind before execution starts; undo the binding if the runtime rejects the send. */
export async function prepareIssueRuntimeTask({
  api,
  port,
  project,
  issueId,
  title,
  address,
  dispatch,
  onStatusError,
}: {
  api: SharedWorkspaceApi
  port: Pick<WeworkWorkspaceRuntimePort, 'bindTask' | 'unbindTask'>
  project: CollaborationProject
  issueId: string
  title: string
  address: RuntimeTaskAddress
  dispatch?: Parameters<WeworkWorkspaceRuntimePort['bindTask']>[3]
  onStatusError(message: string): void
}) {
  const task = toWorkspaceRuntimeTaskAddress(address)
  const projectRef = { projectStore: project.project_store, projectId: String(project.id) }
  await port.bindTask(issueId, task, title, dispatch)
  publishProjectSpaceTaskBindingChanged({ task: address, project: projectRef, type: 'bound' })
  const statusError = await updateIssueWhenPersonalTaskStarts(api.issues, issueId)
  if (statusError !== null) onStatusError(statusError)
  return async () => {
    await port.unbindTask(issueId, task)
    publishProjectSpaceTaskBindingChanged({ task: address, project: projectRef, type: 'unbound' })
  }
}
