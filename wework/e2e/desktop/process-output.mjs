import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'

export function appendProcessOutput(stream, destination) {
  if (!stream) return
  stream.on('data', chunk => {
    // Preserve delivery order across stdout/stderr and finish writes before teardown.
    const startedAt = performance.now()
    appendFileSync(destination, chunk)
    const elapsedMs = performance.now() - startedAt
    if (elapsedMs >= 100) {
      console.warn(
        '[desktop-e2e:slow-process-output]',
        JSON.stringify({
          at: new Date().toISOString(),
          destination: basename(destination),
          bytes: chunk.length,
          elapsedMs,
        })
      )
    }
  })
}
