import { useContext, type ReactNode } from 'react'
import { GitAccountConfigurationProvider } from '@wegent/collaboration/controls'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { openExternalUrl } from '@/lib/external-links'
import { findWorkbenchDevice } from '@/lib/workbench-device'

export function DesktopGitAccountConfigurationProvider({
  children,
  deviceId,
  conversation = false,
}: {
  children: ReactNode
  deviceId?: string
  conversation?: boolean
}) {
  const cloud = useOptionalCloudConnection()
  const workbench = useContext(WorkbenchContext)
  const targetDeviceId =
    deviceId ?? (conversation ? workbench?.state.currentRuntimeTask?.deviceId : undefined)
  const canConfigureDevice = (id: string) => {
    const device = findWorkbenchDevice(workbench?.state.devices ?? [], id)
    return Boolean(
      device?.bind_shell === 'claudecode' &&
      (device.device_type === 'remote' || device.device_type === 'cloud')
    )
  }
  const supported =
    (!conversation && !deviceId) || Boolean(targetDeviceId && canConfigureDevice(targetDeviceId))

  return (
    <GitAccountConfigurationProvider
      value={
        cloud.isConnected && supported
          ? {
              baseUrl: cloud.webUrl,
              openUrl: url => openExternalUrl(url, { source: 'git-access-recovery' }),
              canConfigureDevice,
            }
          : null
      }
    >
      {children}
    </GitAccountConfigurationProvider>
  )
}
