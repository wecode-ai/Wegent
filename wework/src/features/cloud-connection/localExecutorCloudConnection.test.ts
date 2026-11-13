import { beforeEach, expect, test, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { applyLocalExecutorCloudConnection } from './localExecutorCloudConnection'

const native = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
vi.mock('@/desktop/localExecutor', () => ({
  connectLocalExecutorToBackend: native.connect,
  disconnectLocalExecutorFromBackend: native.disconnect,
}))
vi.mock('@/api/http', () => ({
  createHttpClient: () => ({
    post: async () => ({ auth_token: 'synthetic-runtime-token', token_type: 'bearer' }),
  }),
}))
vi.mock('./cloudConnectionAvailability', () => ({ isCloudConnectionUiAvailable: () => true }))
vi.mock('@/features/plugins/pluginNativeAuthorization', () => ({
  configurePluginNativeAuthorization: async () => ({ ready: true, expiresIn: null }),
}))

const connection = {
  apiBaseUrl: 'https://backend.example.test/api',
  backendUrl: 'https://backend.example.test',
  socketBaseUrl: 'https://backend.example.test',
  isConnected: true,
  token: 'synthetic-test-token',
}
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  native.connect.mockReset().mockResolvedValue(undefined)
  native.disconnect.mockReset().mockResolvedValue(undefined)
})

test('an admitted older native write cannot overwrite the server-downlinked socket', async () => {
  const initialWrite = deferred()
  const currentWrite = deferred()
  let initialIsCurrent = true
  let nativeSocket = ''
  native.connect.mockImplementation(async ({ socketBaseUrl }: { socketBaseUrl: string }) => {
    await (socketBaseUrl === connection.socketBaseUrl ? initialWrite.promise : currentWrite.promise)
    nativeSocket = socketBaseUrl
  })
  const first = applyLocalExecutorCloudConnection(connection, { isCurrent: () => initialIsCurrent })
  await vi.waitFor(() => expect(native.connect).toHaveBeenCalledTimes(1))
  initialIsCurrent = false
  const second = applyLocalExecutorCloudConnection({
    ...connection,
    socketBaseUrl: 'wss://socket.example.test',
  })
  try {
    currentWrite.resolve()
    await setImmediate()
    initialWrite.resolve()
    await expect(first).resolves.toEqual({ connected: false })
    await expect(second).resolves.toMatchObject({ connected: true })
    expect(nativeSocket).toBe('wss://socket.example.test')
  } finally {
    initialWrite.resolve()
    currentWrite.resolve()
    await Promise.allSettled([first, second])
  }
})

test('disconnect commits after an already admitted native connection', async () => {
  const initialWrite = deferred()
  let connected = false
  native.connect.mockImplementation(async () => {
    await initialWrite.promise
    connected = true
  })
  native.disconnect.mockImplementation(async () => {
    connected = false
  })
  const first = applyLocalExecutorCloudConnection(connection)
  await vi.waitFor(() => expect(native.connect).toHaveBeenCalledTimes(1))
  const disconnect = applyLocalExecutorCloudConnection({ isConnected: false, token: null })
  try {
    await setImmediate()
    initialWrite.resolve()
    await Promise.all([first, disconnect])
    expect(connected).toBe(false)
  } finally {
    initialWrite.resolve()
    await Promise.allSettled([first, disconnect])
  }
})

test('a superseded queued target never reaches the native connection', async () => {
  const initialWrite = deferred()
  let middleIsCurrent = true
  native.connect.mockImplementationOnce(() => initialWrite.promise)
  const first = applyLocalExecutorCloudConnection(connection)
  await vi.waitFor(() => expect(native.connect).toHaveBeenCalledTimes(1))
  const middle = applyLocalExecutorCloudConnection(
    { ...connection, socketBaseUrl: 'wss://middle.example.test' },
    { isCurrent: () => middleIsCurrent }
  )
  // Let the middle request finish token issuing and enter the native commit queue.
  await setImmediate()
  middleIsCurrent = false
  const latest = applyLocalExecutorCloudConnection({
    ...connection,
    socketBaseUrl: 'wss://latest.example.test',
  })
  try {
    initialWrite.resolve()
    await expect(middle).resolves.toEqual({ connected: false })
    await Promise.all([first, latest])
    expect(native.connect.mock.calls.map(([config]) => config.socketBaseUrl)).toEqual([
      connection.socketBaseUrl,
      'wss://latest.example.test',
    ])
  } finally {
    initialWrite.resolve()
    await Promise.allSettled([first, middle, latest])
  }
})

test('a failed native commit is reported and does not poison subsequent writes', async () => {
  const initialWrite = deferred()
  const failure = new Error('Native connection failed')
  native.connect.mockImplementationOnce(() => initialWrite.promise)
  const first = applyLocalExecutorCloudConnection(connection)
  const failed = expect(first).rejects.toBe(failure)
  await vi.waitFor(() => expect(native.connect).toHaveBeenCalledTimes(1))
  const second = applyLocalExecutorCloudConnection({
    ...connection,
    socketBaseUrl: 'wss://current.example.test',
  })
  initialWrite.reject(failure)
  await failed
  await expect(second).resolves.toMatchObject({ connected: true })
  expect(native.connect).toHaveBeenCalledTimes(2)
})
