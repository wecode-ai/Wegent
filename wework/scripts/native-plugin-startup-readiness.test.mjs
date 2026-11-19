// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { waitForNativeDevelopmentRuntime } from '../e2e/desktop/modules/security-credential-flows.mjs'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../e2e/desktop/modules/runtime-request.mjs', () => ({ invokeLocalHost: invoke }))

let resultDir

beforeEach(async () => {
  resultDir = await mkdtemp(join(tmpdir(), 'wework-native-plugin-startup-'))
  invoke.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(resultDir, { recursive: true, force: true })
})

test('allows a cold child startup within the shared workbench budget', async () => {
  invoke.mockImplementation(async () => [
    {
      id: 'child',
      status: Date.now() >= 65_000 ? 'ready' : 'starting',
      coreDshPid: Date.now() >= 65_000 ? 123 : null,
    },
  ])
  const ready = vi.fn()
  const pending = waitForNativeDevelopmentRuntime({}, 'child', 180_000, resultDir).then(ready)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(ready).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  await pending
  expect(ready).toHaveBeenCalledWith({ id: 'child', status: 'ready', coreDshPid: 123 })
})

test('requires the matching child and a real Core process', async () => {
  invoke.mockImplementation(async () => [
    { id: 'other', status: 'ready', coreDshPid: 456 },
    { id: 'child', status: 'ready', coreDshPid: Date.now() >= 200 ? 123 : null },
  ])
  const ready = vi.fn()
  const pending = waitForNativeDevelopmentRuntime({}, 'child', 1000, resultDir).then(ready)
  await vi.advanceTimersByTimeAsync(100)
  expect(ready).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  expect(ready).toHaveBeenCalledWith({ id: 'child', status: 'ready', coreDshPid: 123 })
})

test.each(['error', 'stopped'])('fails immediately on a terminal %s state', async status => {
  const session = {
    id: 'child',
    status,
    coreDshPid: null,
    lastError: { message: 'startup failed' },
  }
  invoke.mockResolvedValue([session])
  await expect(waitForNativeDevelopmentRuntime({}, 'child', 180_000, resultDir)).rejects.toThrow(
    'Native-approved development runtime terminated: startup failed'
  )
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(
    JSON.parse(await readFile(join(resultDir, 'native-plugin-development-startup-failure.json')))
  ).toEqual(session)
})

test('still fails at the shared deadline and preserves state before cleanup', async () => {
  const session = { id: 'child', status: 'starting', coreDshPid: null }
  invoke.mockResolvedValue([session])
  const rejected = expect(
    waitForNativeDevelopmentRuntime({}, 'child', 500, resultDir)
  ).rejects.toThrow('Native-approved development source did not start its real Core runtime')
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(
    JSON.parse(await readFile(join(resultDir, 'native-plugin-development-startup-failure.json')))
  ).toEqual(session)
})
