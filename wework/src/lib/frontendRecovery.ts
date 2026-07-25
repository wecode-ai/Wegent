import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './runtime-environment'

const REGISTER_FRONTEND_RECOVERY_COMMAND = 'register_frontend_recovery_bridge'
const ACKNOWLEDGE_FRONTEND_RESUME_PROBE_COMMAND = 'acknowledge_frontend_resume_probe'
const FRONTEND_RESUME_PROBE_FUNCTION = '__WEWORK_NATIVE_RESUME_PROBE__'

declare global {
  interface Window {
    __WEWORK_NATIVE_RESUME_PROBE__?: (probeId: number) => void
  }
}

export function installFrontendRecoveryBridge(): void {
  if (!isTauriRuntime()) return

  window[FRONTEND_RESUME_PROBE_FUNCTION] = probeId => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void invoke(ACKNOWLEDGE_FRONTEND_RESUME_PROBE_COMMAND, { probeId }).catch(() => {
          // The native watchdog owns recovery when the acknowledgement cannot be delivered.
        })
      })
    })
  }

  void invoke(REGISTER_FRONTEND_RECOVERY_COMMAND).catch(error => {
    console.warn('[Wework] Failed to register frontend recovery bridge', error)
  })
}
