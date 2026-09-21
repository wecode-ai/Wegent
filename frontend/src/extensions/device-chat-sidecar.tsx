import type { ReactNode } from 'react'

export interface DeviceChatSidecar {
  toolbar: ReactNode
  panel: ReactNode
  open: boolean
  fullscreen: boolean
  reset: () => void
}

export interface DeviceChatSidecarOptions {
  selectedDevice: { device_id: string; device_type?: string; status?: string } | undefined
  selectedDeviceId: string | null
  isMobile: boolean
  hideFilesTab: boolean
}

const emptySidecar: DeviceChatSidecar = {
  toolbar: null,
  panel: null,
  open: false,
  fullscreen: false,
  reset: () => undefined,
}

export function useDeviceChatSidecar(_options: DeviceChatSidecarOptions): DeviceChatSidecar {
  return emptySidecar
}
