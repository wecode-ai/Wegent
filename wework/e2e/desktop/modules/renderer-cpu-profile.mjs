import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createDevtoolsClient, writeDiagnosticFile } from '../../../scripts/ai-verify-devtools.mjs'

export async function startRendererCpuProfile(directory, fileName, timeoutMs) {
  let client
  let target
  try {
    client = await createDevtoolsClient(directory, timeoutMs)
    const targets = await client({ action: 'targets' })
    target = targets.find(
      entry =>
        entry.type === 'window' &&
        !entry.url.startsWith('devtools:') &&
        !entry.url.includes('startup-splash')
    )?.id
    assert.ok(target, 'The main renderer is unavailable for CPU sampling')
    await client({ action: 'command', target, method: 'Profiler.enable' })
    await client({ action: 'command', target, method: 'Profiler.start' })
  } catch {
    if (target) await client({ action: 'detach', target }).catch(() => {})
    console.info('[desktop-e2e-profile] CPU profile unavailable', { phase: 'start' })
    return async () => {}
  }
  const startedAt = Date.now()
  let stopping
  return () =>
    (stopping ??= (async () => {
      try {
        const { profile } = await client({ action: 'command', target, method: 'Profiler.stop' })
        await writeDiagnosticFile(join(directory, fileName), {
          ...profile,
          startedAtUnixMs: startedAt,
          finishedAtUnixMs: Date.now(),
        })
      } catch {
        console.info('[desktop-e2e-profile] CPU profile unavailable', { phase: 'stop' })
      } finally {
        await client({ action: 'detach', target }).catch(() => {})
      }
    })())
}
