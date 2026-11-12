import type { WeworkWorkspaceRuntimePort, WorkspaceRuntimeTaskAddress } from '@wegent/collaboration'

export async function registeredCloudDeviceId(
  deviceId: string,
  identity: (deviceId: string) => Promise<{ backendDeviceId: string }>
): Promise<string> {
  const { backendDeviceId } = await identity(deviceId)
  if (!backendDeviceId?.trim()) throw new Error('Runtime has no registered cloud device identity')
  return backendDeviceId
}

/** Persist the Runtime's registered identity instead of a reusable desktop alias. */
export function canonicalCloudTaskPort(
  port: WeworkWorkspaceRuntimePort,
  identity: (deviceId: string) => Promise<{ backendDeviceId: string }>
): WeworkWorkspaceRuntimePort {
  const address = async (task: WorkspaceRuntimeTaskAddress) => {
    return { ...task, deviceId: await registeredCloudDeviceId(task.deviceId, identity) }
  }
  return {
    ...port,
    async findIssueForTask(task) {
      return port.findIssueForTask(await address(task))
    },
    async findCloudContextForTask(task) {
      return port.findCloudContextForTask(await address(task))
    },
    async bindTask(issueId, task, title, dispatch) {
      return port.bindTask(issueId, await address(task), title, dispatch)
    },
    async unbindTask(issueId, task) {
      return port.unbindTask(issueId, await address(task))
    },
    async unbindCloudContext(task) {
      return port.unbindCloudContext(await address(task))
    },
    async trackProjectTask(projectId, task, title, description) {
      return port.trackProjectTask(projectId, await address(task), title, description)
    },
  }
}
