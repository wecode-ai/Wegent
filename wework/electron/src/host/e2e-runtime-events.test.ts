import { expect, test, vi } from 'vitest'
import { recordE2ERuntimeEvent } from './e2e-runtime-events.js'

test.each([
  ['succeeded', 'info'],
  ['failed', 'error'],
  ['timed_out', 'error'],
  ['skipped_capacity', 'warning'],
])('journals plugin invocation outcome %s as %s', (status, level) => {
  const record = vi.fn()
  const run = {
    runId: 'hook-1',
    pluginId: 'plugin-1',
    handlerId: 'complete',
    status,
    exitCode: status === 'failed' ? 1 : null,
    stderrPreview: 'Hook output',
    stderrTruncated: true,
  }
  recordE2ERuntimeEvent('runtime.hooks.run_completed', { run }, { record })
  expect(record).toHaveBeenCalledExactlyOnceWith('runtime', 'plugin-hook-completed', level, {
    event: 'runtime.hooks.run_completed',
    run,
  })
})

test.each([
  {},
  { run: [] },
  { run: { runId: 'hook-1', status: 'unknown' } },
  { run: { status: 'failed' } },
])('retains malformed invocation outcomes as protocol errors: %j', payload => {
  const record = vi.fn()
  recordE2ERuntimeEvent('runtime.hooks.run_completed', payload, { record })
  expect(record).toHaveBeenCalledExactlyOnceWith('runtime', 'plugin-hook-protocol-error', 'error', {
    event: 'runtime.hooks.run_completed',
    payload,
  })
})

test('leaves unrelated runtime events to their existing collectors', () => {
  const record = vi.fn()
  recordE2ERuntimeEvent('response.completed', {}, { record })
  expect(record).not.toHaveBeenCalled()
})
