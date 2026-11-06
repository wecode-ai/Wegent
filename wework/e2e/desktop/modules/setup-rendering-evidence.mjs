import { writeFile } from 'node:fs/promises'

/** Preserve sanitized rendering measurements on both successful and failed setup paths. */
export function createSetupRenderingEvidence(control, path) {
  const samples = []
  return async stage => {
    const sample = { stage, capturedAt: new Date().toISOString() }
    try {
      const snapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body', { timeoutMs: 5000 })
      )
      sample.rendering = snapshot.conversationRendering ?? null
    } catch (error) {
      sample.error = { name: error instanceof Error ? error.name : 'Error' }
    }
    samples.push(sample)
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, samples }, null, 2)}\n`, 'utf8')
  }
}
