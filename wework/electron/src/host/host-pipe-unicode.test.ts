import { PassThrough, Transform, type TransformCallback } from 'node:stream'
import { compressToUTF16, decompressFromUTF16 } from 'lz-string'
import { expect, test, vi } from 'vitest'
import { ElectronHostClient } from '../../../dsh/electron-host/electron-host-client.js'
import { HostCapabilityRouter } from './capability-router.js'
import { HostPipeServer } from './host-pipe.js'

function fragmentedPipe(chunkSize: number) {
  return new Transform({
    transform(bytes: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        this.push(bytes.subarray(offset, offset + chunkSize))
      }
      callback()
    },
  })
}

function connection(requestValue: string, responseValue: string, chunkSize: number) {
  const router = new HostCapabilityRouter()
  const update = vi.fn(() => ({ value: responseValue }))
  router.register('rendererStorage.update', update)
  router.register('window.getState', () => ({ available: true }))
  router.grant('@wegent/dsh-app-wework', ['rendererStorage.update', 'window.getState'])
  const host = new HostPipeServer(router)
  const toHost = fragmentedPipe(chunkSize)
  const toClient = fragmentedPipe(chunkSize)
  const protocolError = vi.fn()
  const disconnect = vi.fn()
  host.on('protocolError', protocolError)
  host.attachStreams(toHost, toClient)
  const client = new ElectronHostClient({
    token: host.environment().WEWORK_ELECTRON_HOST_TOKEN,
    input: toClient,
    output: toHost,
    timeoutMs: 3000,
    onDisconnect: disconnect,
  })
  return {
    async verify() {
      await client.start()
      expect(await client.invoke('rendererStorage.update', { value: requestValue })).toEqual({
        value: responseValue,
      })
      expect(await client.invoke('window.getState')).toEqual({ available: true })
      expect(update).toHaveBeenCalledWith({ value: requestValue }, expect.any(Object))
      expect(protocolError).not.toHaveBeenCalled()
      expect(disconnect).not.toHaveBeenCalled()
    },
    close() {
      client.stop()
      host.stop()
      toHost.destroy()
      toClient.destroy()
    },
  }
}

for (const direction of ['request', 'response']) {
  test(`preserves Unicode separators and UTF-8 byte fragments in the ${direction}`, async () => {
    const value = '插件🙂\u2028line\u2029paragraph\n\r'
    const fixture = connection(
      direction === 'request' ? value : 'plain',
      direction === 'response' ? value : 'plain',
      1
    )
    try {
      await fixture.verify()
    } finally {
      fixture.close()
    }
  })
}

test('round trips ASCII catalog compressed to UTF-16 without disconnecting later operations', async () => {
  let seed = 1
  const source = JSON.stringify(
    Array.from({ length: 256 }, (_, index) => ({
      name: `plugin-${index}`,
      description: Array.from({ length: 300 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return String.fromCharCode(32 + (seed % 95))
      }).join(''),
    }))
  )
  const compressed = compressToUTF16(source)
  expect(source).toMatch(/^[\x20-\x7e]+$/)
  expect(compressed).toContain('\u2028')
  expect(compressed).toContain('\u2029')
  expect(decompressFromUTF16(compressed)).toBe(source)
  const fixture = connection(compressed, compressed, 64)
  try {
    await fixture.verify()
  } finally {
    fixture.close()
  }
})

test('invalid JSON closes the host session before any subsequent buffered request can run', async () => {
  const router = new HostCapabilityRouter()
  const invoke = vi.fn()
  router.register('window.close', invoke)
  router.grant('@wegent/dsh-app-wework', ['window.close'])
  const host = new HostPipeServer(router)
  const input = new PassThrough()
  const output = new PassThrough()
  const error = vi.fn()
  host.on('protocolError', error)
  host.attachStreams(input, output)
  try {
    input.write(
      `${JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token: host.environment().WEWORK_ELECTRON_HOST_TOKEN,
        principal: '@wegent/dsh-app-wework',
      })}\n`
    )
    input.write(
      `invalid\n${JSON.stringify({
        type: 'request',
        id: 'must-not-run',
        capability: 'window.close',
        params: {},
      })}\n`
    )
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Desktop host frame is not valid JSON' })
    )
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    host.stop()
    input.destroy()
    output.destroy()
  }
})
