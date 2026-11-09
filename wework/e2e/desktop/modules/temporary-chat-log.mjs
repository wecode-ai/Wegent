import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

export async function waitForTemporaryChatLog(logPath, timeoutMs, description, inspect) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const log = await readFile(logPath, 'utf8')
    const result = inspect(log)
    if (result) return { ...result, logLength: log.length }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Timed out waiting for ${description}`)
}
