import { afterEach, expect, test, vi } from 'vitest'
import { runSynchronousStartupStep } from './startup-step.js'

afterEach(() => vi.restoreAllMocks())

test('preserves the synchronous result and execution count', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const result = Symbol('result')
  const operation = vi.fn(() => result)

  expect(runSynchronousStartupStep('development-app-data-read', operation)).toBe(result)
  expect(operation).toHaveBeenCalledOnce()
  expect(info.mock.calls.map(([, event]) => event.status)).toEqual(['started', 'completed'])
})

test.each([
  new SyntaxError('private-path'),
  new TypeError('private-token'),
  new Error('private-url'),
])('reports a fixed kind and propagates the original failure (%#)', failure => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  let caught: unknown
  try {
    runSynchronousStartupStep('development-app-data-read', () => {
      throw failure
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(failure)
  expect(info.mock.calls.map(([, event]) => event.status)).toEqual(['started', 'failed'])
  expect(info.mock.calls.at(-1)?.[1].errorKind).toBe(failure.constructor.name)
  expect(JSON.stringify(info.mock.calls)).not.toContain('private')
})
