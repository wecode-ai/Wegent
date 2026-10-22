import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

export async function readProjectChatMessages(
  { backendUrl, authToken, projectId },
  taskId,
  timeoutMs
) {
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${backendUrl}/wework-runtime`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: authToken },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: timeoutMs,
  })
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
      socket.connect()
    })
    const ack = await socket.timeout(timeoutMs).emitWithAck('wework:project_chat:subscribe', {
      projectId,
      taskId,
      afterSequence: 0,
    })
    assert.equal(ack.ok, true, 'A new client must be able to read persisted activity messages')
    assert.ok(Array.isArray(ack.result.messages), 'The activity snapshot must contain messages')
    return ack.result.messages
  } finally {
    socket.disconnect()
  }
}
