import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export interface SystemRecordingSummary {
  id: string
  title: string
  createdAt: number
  endedAt: number
  stepCount: number
  durationMs: number
  applicationCount: number
  containsHandoff: boolean
}

export interface SystemRecordReplayStatus {
  supported: boolean
  accessibilityGranted: boolean
  inputMonitoringGranted: boolean
  phase: 'idle' | 'recording' | 'replaying' | 'paused' | 'failed'
  recordingId: string | null
  title: string | null
  stepCount: number
  currentStep: number | null
  currentApplication: string | null
  message: string | null
}

export function listSystemRecordings(): Promise<SystemRecordingSummary[]> {
  return invokeDesktopHost('systemRecordReplay.list')
}

export function readSystemRecordReplayStatus(): Promise<SystemRecordReplayStatus> {
  return invokeDesktopHost('systemRecordReplay.status')
}

export function requestSystemRecordReplayPermissions(): Promise<SystemRecordReplayStatus> {
  return invokeDesktopHost('systemRecordReplay.requestPermissions')
}

export function openSystemRecordReplayPermissionSettings(
  permission: 'accessibility' | 'inputMonitoring'
): Promise<void> {
  return invokeDesktopHost('systemRecordReplay.openPermissionSettings', { permission })
}

export function startSystemRecording(title: string): Promise<SystemRecordReplayStatus> {
  return invokeDesktopHost('systemRecordReplay.start', { title })
}

export function stopSystemRecording(preserveStepCount: number): Promise<void> {
  return invokeDesktopHost('systemRecordReplay.stop', { preserveStepCount })
}

export function deleteSystemRecording(id: string): Promise<boolean> {
  return invokeDesktopHost('systemRecordReplay.delete', { id })
}

export function replaySystemRecording(id: string): Promise<SystemRecordReplayStatus> {
  return invokeDesktopHost('systemRecordReplay.replay', { id })
}

export function cancelSystemReplay(): Promise<void> {
  return invokeDesktopHost('systemRecordReplay.cancel')
}
