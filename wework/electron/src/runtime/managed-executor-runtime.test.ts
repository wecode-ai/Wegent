import { createServer } from 'node:net'
import { describe, expect, test } from 'vitest'
import { waitForEndpointAuthentication } from './managed-executor-runtime.js'
import { temporaryDirectory } from './test-helpers.js'

describe('managed executor runtime', () => {
  test('waits for a credentialed local endpoint handshake', async () => {
    const directory = await temporaryDirectory('managed-executor-')
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\managed-executor-${process.pid}-${Date.now()}`
        : `${directory.path}/executor.sock`
    const token = '0123456789abcdef0123456789abcdef'
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.once('data', line => {
        const message = JSON.parse(line) as {
          type: string
          protocol_version: number
          token: string
        }
        socket.write(
          `${JSON.stringify({
            type: 'authenticated',
            ok:
              message.type === 'authenticate' &&
              message.protocol_version === 1 &&
              message.token === token,
            protocol_version: 1,
          })}\n`
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(
        waitForEndpointAuthentication(endpoint, token, AbortSignal.timeout(1_000))
      ).resolves.toBeUndefined()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await directory.remove()
    }
  })
})
