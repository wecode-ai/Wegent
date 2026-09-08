import { createAuthenticatedSocketClient } from '@wegent/chat-core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getToken } from '@/api/auth'
import { getRuntimeConfig } from '@/config/runtime'
import { createRemoteTerminalClient } from './remote-terminal-socket'

vi.mock('@wegent/chat-core', () => ({
  createAuthenticatedSocketClient: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  getToken: vi.fn(),
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: vi.fn(),
}))

const createAuthenticatedSocketClientMock = vi.mocked(createAuthenticatedSocketClient)
const getTokenMock = vi.mocked(getToken)
const getRuntimeConfigMock = vi.mocked(getRuntimeConfig)

describe('createRemoteTerminalClient', () => {
  const emitMock = vi.fn()
  const onMock = vi.fn()
  const offMock = vi.fn()
  const ensureConnectedMock = vi.fn()
  const disposeMock = vi.fn()
  const onReconnectMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    getTokenMock.mockReturnValue('auth-token')
    getRuntimeConfigMock.mockReturnValue({
      appBasePath: '',
      apiBaseUrl: '/api',
      socketBaseUrl: 'http://socket.example',
      socketPath: '/socket.io',
      loginMode: 'all',
      oidcLoginText: '',
      cloudDeviceScalingWikiUrl: '',
    })
    emitMock.mockImplementation((event, payload, ack) => {
      if (typeof ack === 'function') {
        ack({ success: true, ...(event === 'terminal:attach' ? { protocol_version: 2 } : {}) })
      }
    })
    createAuthenticatedSocketClientMock.mockReturnValue({
      socket: {
        connected: true,
        emit: emitMock,
        on: onMock,
        off: offMock,
        disconnect: vi.fn(),
      },
      ensureConnected: ensureConnectedMock,
      dispose: disposeMock,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getRawSocket: vi.fn(),
      getState: vi.fn(),
      subscribe: vi.fn(),
      onReconnect: onReconnectMock,
    })
  })

  test('uses the shared authenticated Socket.IO client for the terminal namespace', async () => {
    const client = createRemoteTerminalClient('terminal-1')

    await client.attach()

    expect(createAuthenticatedSocketClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: '/terminal',
        path: '/socket.io',
        getToken,
      })
    )
    const options = createAuthenticatedSocketClientMock.mock.calls[0][0]
    expect(await options.socketBaseUrl()).toBe('http://socket.example')
    expect(ensureConnectedMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(
      'terminal:attach',
      {
        session_id: 'terminal-1',
        protocol_version: 2,
        consumer_id: expect.any(String),
        last_acked_sequence: 0,
      },
      expect.any(Function)
    )
  })

  test('resumes attach from the last acknowledged output sequence', async () => {
    const client = createRemoteTerminalClient('terminal-1')

    await client.attach(42)

    expect(emitMock).toHaveBeenCalledWith(
      'terminal:attach',
      {
        session_id: 'terminal-1',
        protocol_version: 2,
        consumer_id: expect.any(String),
        last_acked_sequence: 42,
      },
      expect.any(Function)
    )
  })

  test('uses the injected backend for both the socket URL and authentication', async () => {
    const resolveToken = vi.fn(() => 'connected-backend-token')
    const client = createRemoteTerminalClient('terminal-1', {
      socketBaseUrl: 'http://10.201.3.200:8000',
      socketPath: '/socket.io',
      getToken: resolveToken,
    })

    await client.attach()

    expect(getRuntimeConfigMock).not.toHaveBeenCalled()
    const options = createAuthenticatedSocketClientMock.mock.calls[0][0]
    expect(await options.socketBaseUrl()).toBe('http://10.201.3.200:8000')
    expect(options.path).toBe('/socket.io')
    expect(options.getToken).toBe(resolveToken)
  })

  test('relays terminal acknowledgement, input, resize, and close over Socket.IO', async () => {
    const client = createRemoteTerminalClient('terminal-1')

    await client.attach()
    await client.ack(7)
    await client.write('pwd\r')
    await client.resize(32, 120)
    await client.close()

    expect(emitMock).toHaveBeenCalledWith(
      'terminal:ack',
      {
        session_id: 'terminal-1',
        consumer_id: expect.any(String),
        sequence: 7,
      },
      expect.any(Function)
    )
    expect(emitMock).toHaveBeenCalledWith('terminal:input', {
      session_id: 'terminal-1',
      consumer_id: expect.any(String),
      data: 'pwd\r',
    })
    expect(emitMock).toHaveBeenCalledWith('terminal:resize', {
      session_id: 'terminal-1',
      consumer_id: expect.any(String),
      rows: 32,
      cols: 120,
    })
    expect(emitMock).toHaveBeenCalledWith(
      'terminal:close',
      {
        session_id: 'terminal-1',
        consumer_id: expect.any(String),
      },
      expect.any(Function)
    )
    expect(new Set(emitMock.mock.calls.map(([, payload]) => payload.consumer_id)).size).toBe(1)
  })

  test('subscribes only to output for its active consumer', async () => {
    const client = createRemoteTerminalClient('terminal-1')
    const handler = vi.fn()

    const unsubscribe = client.onOutput(handler)
    await client.attach()
    const consumerId = emitMock.mock.calls[0][1].consumer_id
    const activeConsumerHandler = onMock.mock.calls[0][1]
    activeConsumerHandler({
      session_id: 'terminal-1',
      consumer_id: 'other-consumer',
      sequence: 1,
      data: 'ignored',
    })
    activeConsumerHandler({
      session_id: 'terminal-1',
      consumer_id: consumerId,
      sequence: 1,
      data: 'accepted',
    })
    unsubscribe()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ data: 'accepted' }))
    activeConsumerHandler({
      session_id: 'terminal-1',
      consumer_id: consumerId,
      sequence: 2,
      data: 'removed',
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('subscribes to authenticated socket reconnects', () => {
    const unsubscribe = vi.fn()
    const handler = vi.fn()
    onReconnectMock.mockReturnValue(unsubscribe)
    const client = createRemoteTerminalClient('terminal-1')

    const result = client.onReconnect(handler)

    expect(onReconnectMock).toHaveBeenCalledWith(handler)
    expect(result).toBe(unsubscribe)
  })

  function eventHandler(event: string) {
    return onMock.mock.calls.find(([name]) => name === event)![1]
  }

  test.each([undefined, 1])(
    'negotiates legacy reply %s and never sends a browser ACK',
    async version => {
      emitMock.mockImplementation((_event, _payload, ack) => {
        ack?.({ success: true, ...(version === undefined ? {} : { protocol_version: version }) })
      })
      const client = createRemoteTerminalClient('terminal-1')
      const output = vi.fn()
      const exit = vi.fn()
      client.onOutput(output)
      client.onExit(exit)
      await client.attach()
      eventHandler('terminal:output')({ session_id: 'terminal-1', data: 'legacy output' })
      await client.ack(1)
      await client.write('pwd\r')
      await client.resize(30, 90)
      await client.attach(1)
      eventHandler('terminal:output')({ session_id: 'terminal-1', data: 'after reconnect' })
      eventHandler('terminal:exit')({ session_id: 'terminal-1', exit_code: 0 })
      await client.close()

      expect(output.mock.calls.map(([value]) => [value.sequence, value.data])).toEqual([
        [1, 'legacy output'],
        [2, 'after reconnect'],
      ])
      expect(output.mock.calls[0][0].protocol_version).toBe(1)
      expect(exit).toHaveBeenCalledWith(expect.objectContaining({ exit_code: 0 }))
      expect(emitMock.mock.calls.some(([event]) => event === 'terminal:ack')).toBe(false)
      expect(emitMock).toHaveBeenCalledWith('terminal:input', {
        session_id: 'terminal-1',
        data: 'pwd\r',
      })
      expect(emitMock).toHaveBeenCalledWith('terminal:resize', {
        session_id: 'terminal-1',
        rows: 30,
        cols: 90,
      })
      expect(emitMock).toHaveBeenCalledWith(
        'terminal:attach',
        { session_id: 'terminal-1', protocol_version: 1 },
        expect.any(Function)
      )
      expect(emitMock).toHaveBeenCalledWith(
        'terminal:close',
        { session_id: 'terminal-1' },
        expect.any(Function)
      )
    }
  )

  test.each([1, 2])(
    'buffers early output and exit until protocol %s is negotiated',
    async version => {
      let reply: ((value: unknown) => void) | undefined
      emitMock.mockImplementation((_event, _payload, ack) => {
        reply = ack
      })
      const client = createRemoteTerminalClient('terminal-1')
      const received: string[] = []
      client.onOutput(value => received.push(value.data))
      client.onExit(() => received.push('exit'))
      const attached = client.attach()
      await vi.waitFor(() => expect(reply).toBeTypeOf('function'))
      const consumer = emitMock.mock.calls[0][1].consumer_id
      eventHandler('terminal:output')({
        session_id: 'terminal-1',
        data: 'hello',
        ...(version === 2 ? { consumer_id: consumer, sequence: 1 } : {}),
      })
      eventHandler('terminal:exit')({
        session_id: 'terminal-1',
        ...(version === 2 ? { consumer_id: consumer } : {}),
      })
      expect(received).toEqual([])
      reply!({ success: true, protocol_version: version })
      await attached
      expect(received).toEqual(['hello', 'exit'])
    }
  )

  test('does not deliver output from a failed attach', async () => {
    emitMock.mockImplementation((_event, _payload, ack) => {
      eventHandler('terminal:output')({ session_id: 'terminal-1', data: 'not authorized' })
      ack({ success: false, error: 'Access denied' })
    })
    const client = createRemoteTerminalClient('terminal-1')
    const output = vi.fn()
    client.onOutput(output)
    await expect(client.attach()).rejects.toThrow('Access denied')
    expect(output).not.toHaveBeenCalled()
  })

  test.each([
    {},
    { success: false },
    { success: true, protocol_version: 3 },
    { success: true, protocol_version: '2' },
    { success: true, protocol_version: null },
  ])('rejects malformed attach reply %j', async reply => {
    emitMock.mockImplementation((_event, _payload, ack) => ack(reply))
    const client = createRemoteTerminalClient('terminal-1')
    await expect(client.attach()).rejects.toThrow()
  })

  test('rejects a legacy downgrade after v2 has consumed output', async () => {
    const client = createRemoteTerminalClient('terminal-1')
    await client.attach()
    emitMock.mockImplementation((_event, _payload, ack) => ack({ success: true }))
    await expect(client.attach(4)).rejects.toThrow('Terminal protocol changed')
  })

  test('does not upgrade a live legacy session on reconnect', async () => {
    emitMock.mockImplementationOnce((_event, _payload, ack) => ack({ success: true }))
    const client = createRemoteTerminalClient('terminal-1')
    await client.attach()
    await expect(client.attach()).rejects.toThrow('Terminal protocol changed')
    expect(emitMock.mock.calls[1][1]).toEqual({ session_id: 'terminal-1', protocol_version: 1 })
  })

  test.each(['count', 'characters'])(
    'rejects an overflowing pre-attach %s buffer without silent loss',
    async bound => {
      emitMock.mockImplementation((_event, _payload, ack) => {
        const count = bound === 'count' ? 257 : 1
        for (let index = 0; index < count; index++) {
          eventHandler('terminal:output')({
            session_id: 'terminal-1',
            data: bound === 'count' ? 'x' : 'x'.repeat(1024 * 1024 + 1),
          })
        }
        ack({ success: true })
      })
      const client = createRemoteTerminalClient('terminal-1')
      const output = vi.fn()
      client.onOutput(output)
      await expect(client.attach()).rejects.toThrow('bounded attach buffer')
      expect(output).not.toHaveBeenCalled()
    }
  )

  test('rejects legacy or malformed output on a v2 connection', async () => {
    const client = createRemoteTerminalClient('terminal-1')
    const output = vi.fn()
    client.onOutput(output)
    await client.attach()
    const consumerId = emitMock.mock.calls[0][1].consumer_id
    for (const fields of [
      {},
      { consumer_id: consumerId },
      { consumer_id: consumerId, sequence: 0 },
      { consumer_id: consumerId, sequence: '1' },
      { consumer_id: consumerId, sequence: 1, protocol_version: 1 },
      { consumer_id: consumerId, sequence: 1, protocol_version: 3 },
      { consumer_id: consumerId, sequence: 1, protocol_version: null },
    ]) {
      eventHandler('terminal:output')({ session_id: 'terminal-1', data: 'bad', ...fields })
    }
    expect(output).not.toHaveBeenCalled()
  })

  test('rejects partial v2 frames and unrelated sessions on a legacy connection', async () => {
    emitMock.mockImplementation((_event, _payload, ack) => ack({ success: true }))
    const client = createRemoteTerminalClient('terminal-1')
    const output = vi.fn()
    client.onOutput(output)
    await client.attach()
    for (const fields of [
      { sequence: 1 },
      { consumer_id: 'someone' },
      { protocol_version: 2 },
      { protocol_version: 3 },
      { protocol_version: null },
      { session_id: 'someone' },
    ]) {
      eventHandler('terminal:output')({ session_id: 'terminal-1', data: 'bad', ...fields })
    }
    expect(output).not.toHaveBeenCalled()
  })

  test('disposes pending negotiation and cannot render after unmount', async () => {
    let reply: ((value: unknown) => void) | undefined
    emitMock.mockImplementation((_event, _payload, ack) => {
      reply = ack
    })
    const client = createRemoteTerminalClient('terminal-1')
    const output = vi.fn()
    client.onOutput(output)
    const attached = client.attach()
    await vi.waitFor(() => expect(reply).toBeTypeOf('function'))
    eventHandler('terminal:output')({ session_id: 'terminal-1', data: 'buffered' })
    client.dispose()
    reply!({ success: true })
    await expect(attached).rejects.toThrow('disposed')
    expect(output).not.toHaveBeenCalled()
    expect(offMock).toHaveBeenCalledWith('terminal:output', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('terminal:exit', expect.any(Function))
  })

  test('subscribes and unsubscribes socket disconnect handlers', () => {
    const handler = vi.fn()
    const client = createRemoteTerminalClient('terminal-1')

    const unsubscribe = client.onDisconnect(handler)
    unsubscribe()

    expect(onMock).toHaveBeenCalledWith('disconnect', handler)
    expect(offMock).toHaveBeenCalledWith('disconnect', handler)
  })
})
