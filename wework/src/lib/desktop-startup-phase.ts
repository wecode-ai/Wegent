import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'

type DesktopStartupPhase =
  | 'renderer-entry'
  | 'renderer-storage-initialize'
  | 'renderer-storage-restore'
  | 'renderer-storage-request'
  | 'renderer-storage-response-body'
  | 'renderer-storage-replace'
  | 'provider-model-initialize'
  | 'provider-model-read'
  | 'provider-model-migration'
  | 'provider-model-runtime'
  | 'react-mount'
  | 'renderer-startup'
  | 'wework-mount'
  | 'automation-bridge-install'
  | 'controller-client'
  | 'controller-register'
  | 'app-gate'
  | 'home-module-import'
  | 'core-app-module-import'
  | 'module-import-resolved'
  | 'module-stylesheets'
  | 'surface-ready'
  | 'task-bootstrap'
  | 'devices-request'
  | 'task-list-request'

interface DesktopStartupPhaseDetails {
  durationMs?: number
  modulePath?:
    | 'plugins/wework-ui-core-apps.js'
    | 'plugins/wework-ui-home-developer.js'
    | 'plugins/wework-ui-home-focus.js'
  authLoading?: boolean
  preferencesLoaded?: boolean
}

export function markDesktopStartupPhase(
  phase: DesktopStartupPhase,
  status: 'started' | 'completed' | 'failed' | 'waiting',
  details: DesktopStartupPhaseDetails = {}
): void {
  if (!isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
  // Explicit fields keep diagnostic payloads independent of runtime or authentication data.
  console.info(
    '[startup][renderer-phase] ' +
      JSON.stringify({
        phase,
        status,
        navigationTimeMs: Math.round(performance.now()),
        durationMs: details.durationMs,
        modulePath: details.modulePath,
        authLoading: details.authLoading,
        preferencesLoaded: details.preferencesLoaded,
      })
  )
}

export async function traceDesktopStartupPhase<Result>(
  phase: DesktopStartupPhase,
  operation: () => Promise<Result>
): Promise<Result> {
  const started = performance.now()
  markDesktopStartupPhase(phase, 'started')
  try {
    const result = await operation()
    markDesktopStartupPhase(phase, 'completed', { durationMs: performance.now() - started })
    return result
  } catch (error) {
    markDesktopStartupPhase(phase, 'failed', { durationMs: performance.now() - started })
    throw error
  }
}
