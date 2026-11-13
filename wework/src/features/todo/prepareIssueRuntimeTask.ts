import type { CollaborationProject, WeworkWorkspaceRuntimePort } from '@wegent/collaboration'
import type { RuntimeTaskAddress } from '@/types/api'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'

/** Bind before execution starts; undo the binding if the runtime rejects the send. */
export async function prepareIssueRuntimeTask({
  port,
  project,
  issueId,
  title,
  address,
  dispatch,
}: {
  port: Pick<WeworkWorkspaceRuntimePort, 'bindTask' | 'unbindTask'>
  project: CollaborationProject
  issueId: string
  title: string
  address: RuntimeTaskAddress
  dispatch?: Parameters<WeworkWorkspaceRuntimePort['bindTask']>[3]
}) {
  const task = toWorkspaceRuntimeTaskAddress(address)
  const projectRef = { projectStore: project.project_store, projectId: String(project.id) }
  await port.bindTask(issueId, task, title, dispatch)
  publishProjectSpaceTaskBindingChanged({ task: address, project: projectRef, type: 'bound' })
  return async () => {
    await port.unbindTask(issueId, task)
    publishProjectSpaceTaskBindingChanged({ task: address, project: projectRef, type: 'unbound' })
  }
}
