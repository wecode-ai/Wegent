import { afterEach, expect, test, vi } from 'vitest'
import { readAppWorkerMemory } from './app-worker-memory'

afterEach(() => vi.unstubAllGlobals())
const endpoint = new URL('http://localhost/wework/app/__e2e/process-memory')
const memoryBytes = { rss: 100, heapTotal: 80, heapUsed: 30, external: 10, arrayBuffers: 0 }

test.each([
  [21, 22],
  [0, 0],
])('requires a registered positive worker PID (%i, %i)', async (pid, registeredPid) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ pid, memoryBytes })))
  await expect(
    readAppWorkerMemory(endpoint, { processes: [{ pid: registeredPid }] })
  ).rejects.toThrow('unregistered process')
})

test('does not replace invalid counters with zero or retain extra process data', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ pid: 21, memoryBytes: { ...memoryBytes, heapUsed: -1 } })
    )
    .mockResolvedValueOnce(
      Response.json({
        pid: 21,
        memoryBytes: { ...memoryBytes, secret: 'private-marker' },
        argv: ['private-marker'],
      })
    )
  vi.stubGlobal('fetch', fetch)
  await expect(readAppWorkerMemory(endpoint, { processes: [{ pid: 21 }] })).rejects.toThrow(
    'Invalid app worker memory counter'
  )
  const result = await readAppWorkerMemory(endpoint, { processes: [{ pid: 21 }] })
  expect(result).toEqual({ pid: 21, memoryBytes })
  expect(JSON.stringify(result)).not.toContain('private-marker')
})
