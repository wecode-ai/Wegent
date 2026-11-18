import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

export async function verifyErrorCollection(control, timeoutMs) {
  await verifyNativeRpcErrorCollection(control, timeoutMs)
  const after = control.errors.mark()
  await control.command('probeErrorCollection', 'body')
  const match = event => event.source === 'renderer' && event.type === 'collector-probe'
  await control.errors.waitForRecord(match, { after, timeoutMs })
  await control.errors.assertCollectedErrors(control, [{ match, count: 1 }], {
    after,
    source: 'renderer',
    type: 'collector-probe',
    sources: [
      'main',
      'renderer',
      'runtime',
      'network',
      'host-pipe',
      'process',
      'worker',
      'electron-child',
    ],
  })
}

/** Check native failure presence without acknowledging unrelated stderr chunks. */
export async function verifyNativeRpcErrorCollection(control, timeoutMs) {
  const after = control.errors.mark()
  const marker = 'WEWORK_E2E_NATIVE_RPC_ERROR'
  await assert.rejects(
    () =>
      requestExecutor(
        control,
        'runtime.codex.app_server.request',
        { method: 'config/read', params: { includeLayers: marker } },
        timeoutMs
      ),
    error => error.message.includes(marker)
  )
  await control.errors.waitForRecord(
    () => {
      const streams = new Map()
      for (const event of control.errors.query({
        after,
        source: 'runtime',
        type: 'stderr',
        level: 'error',
      })) {
        const key = `${event.instanceId}:${event.details.childPid}`
        streams.set(key, (streams.get(key) ?? '') + event.details.message)
      }
      return [...streams.values()].some(stderr =>
        stderr
          .split('\n')
          .slice(0, -1)
          .some(
            line =>
              line.includes('codex JSON-RPC request failed method=config/read ') &&
              line.includes('-32600') &&
              line.includes(marker)
          )
      )
    },
    { after, timeoutMs }
  )
}
