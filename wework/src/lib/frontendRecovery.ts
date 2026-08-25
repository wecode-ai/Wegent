const FRONTEND_RESUME_PROBE_FUNCTION = '__WEWORK_NATIVE_RESUME_PROBE__'

declare global {
  interface Window {
    __WEWORK_NATIVE_RESUME_PROBE__?: (probeId: number) => void
  }
}

export function installFrontendRecoveryBridge(): void {
  window[FRONTEND_RESUME_PROBE_FUNCTION] = probeId => {
    void probeId
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => undefined)
    })
  }
}
