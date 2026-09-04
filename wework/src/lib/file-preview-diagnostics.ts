import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'

const FILE_PREVIEW_DIAGNOSTIC_CAPABILITY = 'diagnostics.filePreview'
const MAIN_THREAD_PROBE_WARN_MS = 50

let traceSequence = 0
let persistenceWarningLogged = false

export function createFilePreviewTraceId(): string {
  traceSequence += 1
  return `file-preview-${Date.now().toString(36)}-${traceSequence.toString(36)}`
}

export function filePreviewPathMetadata(path: string): {
  extension: string
  pathLength: number
} {
  const normalized = path.trim()
  const fileName = normalized.split(/[\\/]/).at(-1) ?? ''
  const extensionIndex = fileName.lastIndexOf('.')
  return {
    extension:
      extensionIndex > 0 && extensionIndex < fileName.length - 1
        ? fileName.slice(extensionIndex + 1).toLowerCase()
        : '',
    pathLength: normalized.length,
  }
}

export function logFilePreviewDiagnostic(
  traceId: string,
  stage: string,
  data: Record<string, unknown> = {}
): void {
  const event = {
    traceId,
    stage,
    timestampMs: Date.now(),
    performanceNowMs: roundTiming(performance.now()),
    ...data,
  }
  console.info('[Wework][file-preview]', event)
  if (!isElectronRuntime()) return

  void invokeDesktopHost(FILE_PREVIEW_DIAGNOSTIC_CAPABILITY, { event }).catch(error => {
    if (persistenceWarningLogged) return
    persistenceWarningLogged = true
    console.warn('[Wework][file-preview] persistent diagnostics unavailable', error)
  })
}

export function scheduleFilePreviewMainThreadProbe(traceId: string, afterStage: string): void {
  const scheduledAt = performance.now()
  window.setTimeout(() => {
    const lagMs = performance.now() - scheduledAt
    logFilePreviewDiagnostic(traceId, 'renderer_queue_probe', {
      afterStage,
      lagMs: roundTiming(lagMs),
      blocked: lagMs >= MAIN_THREAD_PROBE_WARN_MS,
    })
  }, 0)
}

export function filePreviewElapsedMs(startedAt: number): number {
  return roundTiming(performance.now() - startedAt)
}

function roundTiming(value: number): number {
  return Math.round(value * 10) / 10
}
