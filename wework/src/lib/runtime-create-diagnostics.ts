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
  void serializeDiagnostic(entry)
}
