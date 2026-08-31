import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { CloudRuntimeTransport } from './cloud-runtime-transport.js'
import { ExecutorRuntimeClient } from './executor-runtime-client.js'

test('uses the same stateless RPC client contract for a cloud relay', async () => {
  const socket = new FakeRuntimeSocket()
  const client = new ExecutorRuntimeClient({
    transport: new CloudRuntimeTransport({
      socket,
      deviceId: 'cloud-device',
      disposeSocket: false,
    }),
  })
  try {
    await client.start()
    assert.equal(client.describe().device_id, 'cloud-device')
    assert.deepEqual(await client.request('executor.health'), {
      healthy: true,
      transport: 'cloud',
    })
    assert.equal(client.replay, undefined)
  } finally {
    await client.stop()
  }
})

class FakeRuntimeSocket extends EventEmitter {
  async ensureConnected() {}

  emit(event, payload, acknowledgement) {
    if (event !== 'runtime:request') return super.emit(event, payload)
    assert.equal(payload.device_id, 'cloud-device')
    const result =
      payload.method === 'executor.protocol.describe'
        ? {
            protocol_version: 1,
            device_id: 'cloud-device',
            capabilities: ['executor.health'],
            renderer_methods: ['executor.health'],
            transports: ['socketio-runtime-relay'],
            features: {
              request_response: true,
              events: true,
              structured_errors: true,
              compressed_responses: true,
              event_resume: false,
            },
          }
        : { healthy: true, transport: 'cloud' }
    acknowledgement({
      ok: true,
      result: {
        __runtimeRpcEncoding: 'gzip+base64+json',
        payload: gzipSync(JSON.stringify(result)).toString('base64'),
      },
    })
    return true
  }

  emitRuntimeEvent(value) {
    super.emit('runtime:event', value)
  }

  dispose() {}
}
