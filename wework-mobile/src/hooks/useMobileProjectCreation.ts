import * as Crypto from 'expo-crypto'
import { useCallback, type RefObject } from 'react'
import { mobileProjectCreatableDevices } from '@/domain/deviceOrdering'
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
          throw new Error('所选设备当前不可创建项目，请检查设备连接和远程任务授权')
        const path = input.workspacePath.trim()
        const result = await api.upsertLocalProject({
          deviceId: input.deviceId,
          projectKey: Crypto.randomUUID(),
          roots: [path],
          name: input.name.trim() || path.split(/[/\\]/u).filter(Boolean).at(-1) || path,
          runtime: 'codex',
        })
        if (!result.accepted) throw new Error(result.error || '项目创建失败')
        publishSelectedDevice(input.deviceId)
        let work: RuntimeWorkListResponse
        try {
          work = await reloadWork(input.deviceId)
        } catch {
          // The accepted project write must not be retried after a list read fails.
          return
        }
        const workspace = work.projects
          .find(group => group.project.key === result.projectKey)
          ?.deviceWorkspaces.find(
            candidate =>
              candidate.deviceId === input.deviceId && candidate.workspacePath === result.roots[0]
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
