// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { prepareHistoryRetention } from '../../e2e/desktop/modules/coordination-history-retention.mjs'

test('observes active polling before pausing only the fixture and waiting for its coordinator', async () => {
  vi.useFakeTimers()
  try {
    const settings = {
      userId: 9001,
      version: 17,
      executionDeviceId: 'fixture-device',
      primary: { enabled: true, prompt: 'Keep primary configuration' },
      roles: [{ id: 'history-owner', enabled: true, collaboration: { enabled: true } }],
    }
    const calls: string[] = []
    const rpc = vi.fn(async (method: string, payload: unknown) => {
      calls.push(method)
      if (method === 'runtime.stand_in.personal.get') {
        assert.deepEqual(payload, { userId: settings.userId })
        return settings
      }
      if (method === 'runtime.stand_in.personal.save') {
        assert.deepEqual(payload, {
          userId: settings.userId,
          settings: {
            ...settings,
            primary: { ...settings.primary, enabled: false },
            roles: settings.roles.map(role => ({ ...role, enabled: false })),
          },
        })
        return undefined
      }
      assert.equal(method, 'runtime.coordination.status')
      assert.deepEqual(payload, { contextId: 'personal:9001' })
      return { running: false, batchId: null }
    })
    const get = vi.fn(() => ({ count: 80_000 }))
    const prepare = vi.fn(() => ({ get }))
    let settled = false
    const retained = prepareHistoryRetention({
      database: { prepare },
      rpc,
      userId: settings.userId,
      historyCount: 80_000,
      async until(load: () => Promise<unknown>, ready: (state: unknown) => boolean) {
        assert.equal(ready({ running: true, batchId: null }), false)
        assert.equal(ready({ running: false, batchId: 'active-batch' }), false)
        assert.equal(ready(await load()), true)
      },
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(9_999)
    assert.equal(settled, false)
    assert.equal(rpc.mock.calls.length, 0, 'The polling assertion must precede pausing')
    await vi.advanceTimersByTimeAsync(1)
    await retained
    assert.deepEqual(calls, [
      'runtime.stand_in.personal.get',
      'runtime.stand_in.personal.save',
      'runtime.coordination.status',
    ])
    assert.equal(get.mock.calls.length, 21)
    assert.equal(settings.primary.enabled, true)
    assert.equal(settings.roles[0].enabled, true)
  } finally {
    vi.useRealTimers()
  }
})

test('a duplicate failed action still fails before the fixture can be paused', async () => {
  const rpc = vi.fn()
  await assert.rejects(
    prepareHistoryRetention({
      database: { prepare: () => ({ get: () => ({ count: 80_001 }) }) },
      rpc,
      until: vi.fn(),
      userId: 9001,
      historyCount: 80_000,
    }),
    /Background polling must not replan failed events/
  )
  assert.equal(rpc.mock.calls.length, 0)
})
