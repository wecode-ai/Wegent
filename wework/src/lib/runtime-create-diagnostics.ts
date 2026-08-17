import { info as writeInfoLog } from '@tauri-apps/plugin-log'

const LOG_PREFIX = '[Wework] Runtime task create diagnostic'

function serializeDiagnostic(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry)
  } catch {
    return JSON.stringify({
      stage: entry.stage,
      serializationFailed: true,
    })
  }
}

export function logRuntimeTaskCreateStage(stage: string, details: Record<string, unknown>): void {
  const entry = {
    stage,
    ...details,
  }
  console.info(LOG_PREFIX, entry)
  try {
    void writeInfoLog(`${LOG_PREFIX} ${serializeDiagnostic(entry)}`).catch(() => undefined)
  } catch {
    // Diagnostics must never interrupt runtime task creation.
  }
}
