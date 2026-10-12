import { appendFileSync } from 'node:fs'

export function appendProcessOutput(stream, destination) {
  if (!stream) return
  stream.on('data', chunk => {
    // Preserve delivery order across stdout/stderr and finish writes before teardown.
    appendFileSync(destination, chunk)
  })
}
