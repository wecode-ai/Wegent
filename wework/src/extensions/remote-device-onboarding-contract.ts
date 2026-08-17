import type { ComponentType } from 'react'

import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'

export type RemoteDeviceConnectionStatus =
  | 'idle'
  | 'waiting'
  | 'connecting'
  | 'online'
  | 'version_mismatch'
  | 'connection_failed'

export interface RemoteDeviceCommandDetailsProps {
  command: DockerRemoteDeviceCommandResponse
  status: RemoteDeviceConnectionStatus
}

export interface RemoteDeviceOnboardingExtension {
  Notice: ComponentType
  CommandDetails: ComponentType<RemoteDeviceCommandDetailsProps>
}
