interface HarnessAppLaunchDiagnostics {
  installationId: string
  modelLabels: string[]
}

interface CaptureRequest {
  installationId: string
  capture: (snapshot: HarnessAppLaunchDiagnostics) => void
}

const EVENT = 'wework:e2e:harness-app-launch-diagnostics'

function requireE2E(): void {
  if (import.meta.env.MODE !== 'e2e' && import.meta.env.VITE_WEWORK_E2E !== 'true') {
    throw new Error('Harness app launch diagnostics are only available in E2E mode')
  }
}

// Observe a connected launcher's actual catalog; no state or delivery is altered.
export function observeHarnessAppLaunchCatalog(
  installationId: string,
  modelLabels: string[]
): () => void {
  requireE2E()
  const listener = (event: Event) => {
    const request = (event as CustomEvent<CaptureRequest>).detail
    if (request.installationId === installationId) {
      request.capture({ installationId, modelLabels: [...modelLabels] })
    }
  }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

export function captureHarnessAppLaunchDiagnostics(
  installationId: string
): HarnessAppLaunchDiagnostics | null {
  requireE2E()
  let snapshot: HarnessAppLaunchDiagnostics | null = null
  window.dispatchEvent(
    new CustomEvent<CaptureRequest>(EVENT, {
      detail: {
        installationId,
        capture: value => {
          snapshot = value
        },
      },
    })
  )
  return snapshot
}
