import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { DEFAULT_STEP_TIMEOUT_MS, assert } from './shared.mjs'

/** Use the same authenticated cloud Runtime request envelope as PC and Mobile. */
export async function withCloudRuntimeRequest(cloudEnvironment, verify) {
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${cloudEnvironment.backendUrl}/wework-runtime`, {
    path: '/socket.io',
    auth: { token: cloudEnvironment.authToken, client_origin: 'wework' },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    timeout: DEFAULT_STEP_TIMEOUT_MS,
  })
  const request = async (method, params, deviceId) => {
    const ack = await socket.timeout(DEFAULT_STEP_TIMEOUT_MS).emitWithAck('runtime:request', {
      type: 'request',
      id: randomUUID(),
      device_id: deviceId,
      method,
      params,
    })
    assert.equal(ack.ok, true, ack.error?.message)
    return ack.result?.__runtimeRpcEncoding === 'gzip+base64+json'
      ? JSON.parse(gunzipSync(Buffer.from(ack.result.payload, 'base64')).toString('utf8'))
      : ack.result
  }
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
      socket.connect()
    })
    return await verify(request)
  } finally {
    socket.disconnect()
  }
}
