import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const { readFile, requestRuntime } = vi.hoisted(() => ({
  readFile: vi.fn(),
  requestRuntime: vi.fn(),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, readFile, default: { ...actual.default, readFile } }
})

import { waitForRestartedExecutor } from '../e2e/desktop/modules/executor-restart-readiness.mjs'

const OLD_PID = 100
const NEW_PID = 200
const oldProtocol =
  'app IPC request started request_id=old method=executor.protocol.describe\n' +
  'app IPC request finished request_id=old method=executor.protocol.describe ok=true\n'
const newSpawn = `[supervisor] spawned pid=${NEW_PID}\n`
const newProtocol =
  'app IPC request started request_id=new method=executor.protocol.describe\n' +
  'app IPC request finished request_id=new method=executor.protocol.describe ok=true\n'

function readiness(logContent, { pid = NEW_PID, timeoutMs = 500 } = {}) {
  readFile.mockImplementation(async () => logContent())
  const control = {
    command: vi.fn(async (action, _selector, options) => {
      if (action === 'getLocationOrigin') return 'http://127.0.0.1:12345'
      if (action === 'fetchLocalRuntime') {
        const request = JSON.parse(options.value)
        expect(options.timeoutMs).toBe(request.timeoutMs)
        expect(request.timeoutMs).toBeGreaterThan(0)
        expect(request.timeoutMs).toBeLessThanOrEqual(timeoutMs)
        return JSON.stringify(await requestRuntime(request))
      }
      expect(action).toBe('getDesktopRuntimeDiagnostics')
      return JSON.stringify({ executorPid: pid })
    }),
  }
  return waitForRestartedExecutor({
    control,
    originalPid: OLD_PID,
    executorLogPath: '/executor.log',
    logOffset: 0,
    timeoutMs,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn())
  requestRuntime.mockReset()
  requestRuntime.mockResolvedValue({ status: 200, headers: {}, body: '{}' })
})

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test('a new PID and successful old-process logs do not make the restarted executor ready', async () => {
  let logContent = oldProtocol + newSpawn
  let settled = false
  const pending = readiness(() => logContent).then(pid => {
    settled = true
    return pid
  })

  await vi.advanceTimersByTimeAsync(100)
  expect(settled).toBe(false)
  expect(requestRuntime).not.toHaveBeenCalled()

  logContent += newProtocol
  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toBe(NEW_PID)
})

test('fresh protocol success waits for the cached DSH bridge description to become ready', async () => {
  requestRuntime
    .mockResolvedValueOnce({ status: 503, headers: {}, body: '{}' })
    .mockResolvedValueOnce({ status: 503, headers: {}, body: '{}' })
  let settled = false
  const pending = readiness(() => newSpawn + newProtocol).then(pid => {
    settled = true
    return pid
  })

  await vi.advanceTimersByTimeAsync(100)
  expect(settled).toBe(false)
  expect(requestRuntime).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toBe(NEW_PID)
  expect(requestRuntime).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: 'http://127.0.0.1:12345/wework/executor/v1',
      headers: { accept: 'application/json' },
      timeoutMs: expect.any(Number),
    })
  )
})

test('the current restarted process and ready bridge complete without another polling delay', async () => {
  await expect(readiness(() => oldProtocol + newSpawn + newProtocol)).resolves.toBe(NEW_PID)
  expect(requestRuntime).toHaveBeenCalledTimes(1)
})

test.each([
  ['old PID', () => newSpawn + newProtocol, { pid: OLD_PID }],
  ['old logs after a new PID', () => oldProtocol + newSpawn, {}],
  [
    'a protocol response for a different request',
    () => newSpawn + newProtocol.replace('finished request_id=new', 'finished request_id=other'),
    {},
  ],
  [
    'a protocol response after the process exited',
    () => newSpawn + '[supervisor] exited code=0 signal=null expected=false\n' + newProtocol,
    {},
  ],
])('times out within the existing budget with %s', async (_name, logContent, options) => {
  const rejected = expect(readiness(logContent, options)).rejects.toThrow(
    'The restarted executor did not become protocol-ready through the DSH bridge'
  )
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(requestRuntime).not.toHaveBeenCalled()
})

test('bridge recovery must finish within the same readiness timeout', async () => {
  requestRuntime.mockResolvedValue({ status: 503, headers: {}, body: '{}' })
  const rejected = expect(readiness(() => newSpawn + newProtocol)).rejects.toThrow(
    'The restarted executor did not become protocol-ready through the DSH bridge'
  )
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(requestRuntime).toHaveBeenCalledTimes(5)
})
