import { useCallback, type RefObject } from 'react'
import { mobileProjectCreatableDevices } from '@/domain/deviceOrdering'
import { allWorkspaces } from '@/domain/work'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/runtime'
import { messageFrom } from './mobileRuntimeHelpers'

export function useMobileProjectCreation({
  api,
  devices,
  publishSelectedDevice,
  reloadWork,
  startNewConversation,
  setLoading,
  setError,
}: {
  api: RuntimeApi
  devices: RefObject<DeviceInfo[]>
  publishSelectedDevice: (deviceId: string) => unknown
  reloadWork: (deviceId: string) => Promise<RuntimeWorkListResponse>
  startNewConversation: (workspace?: RuntimeDeviceWorkspace) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}) {
  return useCallback(
    async (input: { deviceId: string; workspacePath: string; name: string }) => {
      setLoading(true)
      setError(null)
      try {
        if (
          !mobileProjectCreatableDevices(devices.current).some(
            device => device.device_id === input.deviceId
          )
        )
          throw new Error('请在电脑端创建项目')
        const result = await api.openWorkspace({
          deviceId: input.deviceId,
          workspacePath: input.workspacePath.trim(),
        })
        if (!result.accepted) throw new Error(result.error || '项目创建失败')
        if (input.name.trim())
          await api.renameWorkspace({
            deviceId: input.deviceId,
            workspacePath: result.workspacePath,
            name: input.name.trim(),
          })
        publishSelectedDevice(input.deviceId)
        const work = await reloadWork(input.deviceId)
        const workspace = allWorkspaces(work).find(
          candidate =>
            candidate.deviceId === input.deviceId &&
            candidate.workspacePath === result.workspacePath
        )
        if (workspace) startNewConversation(workspace)
      } catch (cause) {
        setError(messageFrom(cause))
        throw cause
      } finally {
        setLoading(false)
      }
    },
    [api, devices, publishSelectedDevice, reloadWork, startNewConversation, setLoading, setError]
  )
}
