import { afterEach, expect, it, vi } from 'vitest'
import { settleMcpAppCleanup } from './mcp-app-sessions.js'

afterEach(() => vi.useRealTimers())

it('bounds shutdown even when a cloud release never settles', async () => {
  vi.useFakeTimers()
  const operation = settleMcpAppCleanup([() => new Promise(() => {})])
  const rejected = expect(operation).rejects.toThrow('MCP App cleanup timed out')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('clears its deadline after cleanup and preserves individual release failures', async () => {
  vi.useFakeTimers()
  const results = await settleMcpAppCleanup([
    async () => {},
    async () => {
      throw new Error('Release failed')
    },
  ])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(vi.getTimerCount()).toBe(0)
})
