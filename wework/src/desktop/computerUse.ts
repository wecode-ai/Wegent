import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export interface ComputerUseStatus {
  supported: boolean
  requiresPermissions: boolean
  enabled: boolean
  running: boolean
  accessibilityPermissionGranted: boolean
  screenRecordingPermissionGranted: boolean
  currentTool: string | null
  error: string | null
}

export function getComputerUseStatus(): Promise<ComputerUseStatus> {
  return invokeDesktopHost('computerUse.status')
}

export function setComputerUseEnabled(enabled: boolean): Promise<ComputerUseStatus> {
  return invokeDesktopHost('computerUse.setEnabled', { enabled })
}

export function requestComputerUsePermissions(): Promise<ComputerUseStatus> {
  return invokeDesktopHost('computerUse.requestPermissions')
}

export function openComputerUseScreenRecordingSettings(): Promise<void> {
  return invokeDesktopHost('computerUse.openScreenRecordingSettings')
}

export function stopComputerUseCurrentAction(): Promise<ComputerUseStatus> {
  return invokeDesktopHost('computerUse.stopCurrentAction')
}
