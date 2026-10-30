import type { StartupFailureSnapshot } from './startup-diagnostics.js'

export interface StartupFailureContext {
  source: string
  stage?: string
  pluginName?: string
}

export function startupFailureSnapshot(
  error: unknown,
  context: StartupFailureContext
): StartupFailureSnapshot {
  const details = error && typeof error === 'object' ? error : null
  const message =
    details && 'message' in details && typeof details.message === 'string'
      ? details.message
      : String(error)
  const stack =
    details && 'stack' in details && typeof details.stack === 'string' ? details.stack : undefined
  return { message, ...(stack ? { stack } : {}), ...context }
}
