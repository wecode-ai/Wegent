import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
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
    command: vi.fn(async action => {
      if (action === 'getLocationOrigin') return 'http://desktop.test'
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})

afterEach(() => {
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
  expect(fetch).not.toHaveBeenCalled()

  logContent += newProtocol
  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toBe(NEW_PID)
})

test('fresh protocol success waits for the cached DSH bridge description to become ready', async () => {
  fetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false })
  let settled = false
  const pending = readiness(() => newSpawn + newProtocol).then(pid => {
    settled = true
    return pid
  })

  await vi.advanceTimersByTimeAsync(100)
  expect(settled).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toBe(NEW_PID)
  expect(fetch).toHaveBeenLastCalledWith(
    'http://desktop.test/wework/executor/v1',
    expect.objectContaining({ headers: { accept: 'application/json' } })
  )
})

test('the current restarted process and ready bridge complete without another polling delay', async () => {
  await expect(readiness(() => oldProtocol + newSpawn + newProtocol)).resolves.toBe(NEW_PID)
  expect(fetch).toHaveBeenCalledTimes(1)
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
  expect(fetch).not.toHaveBeenCalled()
})

test('bridge recovery must finish within the same readiness timeout', async () => {
  fetch.mockResolvedValue({ ok: false })
  const rejected = expect(readiness(() => newSpawn + newProtocol)).rejects.toThrow(
    'The restarted executor did not become protocol-ready through the DSH bridge'
  )
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(fetch).toHaveBeenCalledTimes(5)
})
