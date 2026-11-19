import { writeFile } from 'node:fs/promises'
import { withRunningAppInspector } from './inspect-before-start.mjs'
import { summarizeHeapRetainers } from './heap-retainers.mjs'

/** Raw heap data stays in the test driver memory and is never written or uploaded. */
export async function captureFailureHeap(control, userDataDirectory) {
  if (!control.nativeInspectorPort || !control.applicationProcessId)
    return { available: false, reason: 'native-inspector-unavailable' }
  return withRunningAppInspector(
    control.nativeInspectorPort,
    control.applicationProcessId,
    async (command, socket) => {
      const identity = await command('Runtime.evaluate', {
        expression:
          "process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').app.getPath('userData')",
        returnByValue: true,
      })
      if (identity.exceptionDetails || identity.result?.value !== userDataDirectory)
        throw new Error('Heap diagnostics escaped the isolated profile')
      const chunks = []
      let bytes = 0
      let oversized = false
      let malformed = false
      const receive = event => {
        const message = JSON.parse(event.data)
        if (message.method !== 'HeapProfiler.addHeapSnapshotChunk') return
        const chunk = message.params.chunk
        if (typeof chunk !== 'string') {
          malformed = true
          return
        }
        bytes += Buffer.byteLength(chunk)
        if (bytes > 128 * 1024 * 1024) {
          oversized = true
          chunks.length = 0
          return
        }
        chunks.push(chunk)
      }
      socket.addEventListener('message', receive)
      try {
        await command('HeapProfiler.takeHeapSnapshot')
        if (malformed) return { available: false, reason: 'invalid-snapshot-chunk' }
        if (oversized) return { available: false, reason: 'snapshot-size-limit', bytes }
        return {
          available: true,
          pid: control.applicationProcessId,
          bytes,
          ...summarizeHeapRetainers(JSON.parse(chunks.join(''))),
        }
      } finally {
        socket.removeEventListener('message', receive)
        chunks.length = 0
        await command('HeapProfiler.disable')
      }
    }
  )
}

/** Persist the original failure before calling this best-effort diagnostic. */
export async function writeFailureHeap(control, userDataDirectory, outputPath) {
  let report
  try {
    report = await captureFailureHeap(control, userDataDirectory)
  } catch (error) {
    report = { available: false, errorType: error?.name ?? 'UnknownError' }
  }
  try {
    await writeFile(outputPath, JSON.stringify(report, null, 2))
  } catch {
    console.warn('[desktop-e2e] Main heap diagnostic report could not be written')
  }
}
