import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroupApi } from '@/api/chatGroups'

/** Native Groups authorize only devices exposed by the private local device port. */
export function localGroupExecutionDevices(
  groups: ChatGroupApi,
  groupId: string,
  base: SharedWorkspaceApi,
  onMutation: () => void
): Pick<
  SharedWorkspaceApi['projects'],
  'listExecutionEnvironments' | 'addExecutionEnvironment' | 'removeExecutionEnvironment'
> {
  const available = async () => base.resources?.devices.local?.() ?? []
  const requireScope = (id: string) => {
    if (id !== groupId) throw new Error('Execution device belongs to another Group')
  }
  const change = async (id: string, deviceId: number, add: boolean) => {
    requireScope(id)
    const device = (await available()).find(item => item.device_id === deviceId)
    if (!device?.device_key) throw new Error('Local execution device is unavailable')
    const { group } = await groups.get(groupId)
    if (group.status !== 'active' || !['Owner', 'Maintainer'].includes(group.role)) {
      throw new Error('Active Group administrator permission is required')
    }
    const environment = group.configuration?.execution_environment
    const devices = { ...environment?.devices }
    if (add) devices[device.device_key] ??= {}
    else delete devices[device.device_key]
    await groups.update(groupId, {
      name: group.name,
      description: group.description,
      status: group.status,
      version: group.version,
      configuration: {
        execution_environment: {
          ...environment,
          repositories: environment?.repositories ?? [],
          setup_steps: environment?.setup_steps ?? [],
          devices,
        },
      },
    })
    onMutation()
    return device
  }
  return {
    async listExecutionEnvironments(id) {
      requireScope(id)
      const [{ group }, devices] = await Promise.all([groups.get(groupId), available()])
      const authorized = group.configuration?.execution_environment?.devices ?? {}
      return devices.filter(item => item.device_key && authorized[item.device_key])
    },
    addExecutionEnvironment: (id, deviceId) => change(id, deviceId, true),
    async removeExecutionEnvironment(id, deviceId) {
      await change(id, deviceId, false)
    },
  }
}
