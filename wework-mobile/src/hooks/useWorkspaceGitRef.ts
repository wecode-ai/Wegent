import { useEffect, useState } from 'react'

import { mobileProjectCreatableDevices } from '@/domain/deviceOrdering'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, RuntimeDeviceWorkspace } from '@/types/runtime'

export function useWorkspaceGitRef(
  api: RuntimeApi,
  isDraft: boolean,
  workspace: RuntimeDeviceWorkspace | null,
  devices: DeviceInfo[]
): string | null {
  const [gitRef, setGitRef] = useState<string | null>(null)
  const deviceId = workspace?.deviceId
  const sourcePath = workspace?.workspacePath
  const canPreflight =
    isDraft && mobileProjectCreatableDevices(devices).some(device => device.device_id === deviceId)

  useEffect(() => {
    setGitRef(null)
    if (!canPreflight || !deviceId || !sourcePath) return
    let active = true
    void api
      .preflightWorkspace({ deviceId, sourcePath })
      .then(result => {
        if (active) setGitRef(result.gitRepository ? (result.gitRef ?? null) : null)
      })
      .catch(() => {
        if (active) setGitRef(null)
      })
    return () => {
      active = false
    }
  }, [api, canPreflight, deviceId, sourcePath])

  return gitRef
}
