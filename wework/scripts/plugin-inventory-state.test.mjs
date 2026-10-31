import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import {
  refreshPluginInventory,
  waitForBundledPluginMarketplace,
} from '../e2e/desktop/modules/plugin-inventory-state.mjs'

test('waits for marketplace initialization after the executor is already ready', async () => {
  vi.useFakeTimers()
  try {
    let marketplace = null
    const control = {
      command: vi.fn(async () => JSON.stringify({ marketplace })),
    }
    let finished = false
    const waiting = waitForBundledPluginMarketplace(control, 1000).then(result => {
      finished = true
      return result
    })
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(finished, false, 'Executor readiness must not imply marketplace readiness')

    marketplace = {}
    await vi.advanceTimersByTimeAsync(100)
    assert.equal(finished, false, 'An inventory without a path is not initialized')

    marketplace = { path: '/isolated-runtime/capabilities/bundled-marketplaces/wework-personal' }
    await vi.advanceTimersByTimeAsync(100)
    assert.deepEqual(await waiting, marketplace)
    assert.equal(finished, true)
    for (const args of control.command.mock.calls)
      assert.deepEqual(args, ['getBundledPluginUpdates', 'body'])
  } finally {
    vi.useRealTimers()
  }
})

test('returns an initialized marketplace without an extra polling delay', async () => {
  vi.useFakeTimers()
  try {
    const marketplace = { path: '/initialized-marketplace' }
    const control = { command: async () => JSON.stringify({ marketplace }) }
    assert.deepEqual(await waitForBundledPluginMarketplace(control), marketplace)
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.useRealTimers()
  }
})

test('fails at the supplied readiness deadline if the marketplace never initializes', async () => {
  vi.useFakeTimers()
  try {
    const control = { command: async () => JSON.stringify({ marketplace: null }) }
    let timedOut = false
    const rejected = assert
      .rejects(waitForBundledPluginMarketplace(control, 200), /marketplace did not initialize/)
      .then(() => {
        timedOut = true
      })
    await vi.advanceTimersByTimeAsync(199)
    assert.equal(timedOut, false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    assert.equal(timedOut, true)
  } finally {
    vi.useRealTimers()
  }
})

test('propagates marketplace diagnostic failures without retrying the command', async () => {
  const failure = new Error('Desktop control disconnected')
  const control = { command: vi.fn().mockRejectedValue(failure) }
  await assert.rejects(waitForBundledPluginMarketplace(control), error => error === failure)
  assert.equal(control.command.mock.calls.length, 1)
})

const REFRESH = '[data-testid="plugins-refresh-button"]'

function inventoryControl(initialRevision) {
  const calls = []
  const waiting = []
  let revision = initialRevision
  let busy = false
  const settle = () => {
    for (const waiter of [...waiting]) {
      const target = waiter.selector.match(/data-reconciliation-revision="(\d+)"/)?.[1]
      if (busy || (target !== undefined && target !== revision)) continue
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
  return {
    calls,
    setState(next) {
      if ('revision' in next) revision = next.revision
      if ('busy' in next) busy = next.busy
      settle()
    },
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') return revision
      if (action === 'clickWhenEnabled') {
        assert.equal(busy, false, 'Refresh must wait for an existing operation to finish')
        busy = true
        return ''
      }
      if (action === 'waitFor') {
        await new Promise(resolve => {
          waiting.push({ selector, resolve })
          settle()
        })
        return ''
      }
      throw new Error(`Unexpected inventory action: ${action}`)
    },
  }
}

test.each(['0', '7'])(
  'waits for reconciliation after catalog refresh from revision %s and preserves the slow-operation budget',
  async initialRevision => {
    const control = inventoryControl(initialRevision)
    let finished = false
    const refreshing = refreshPluginInventory(control, 60_000).then(() => {
      finished = true
    })
    await vi.waitFor(() => assert.equal(control.calls.length, 4))
    // Catalog loading can finish before the reconciliation effect starts.
    control.setState({ busy: false })
    await Promise.resolve()
    assert.equal(finished, false)
    // The new revision alone is insufficient while the catalog remains busy.
    control.setState({ revision: String(Number(initialRevision) + 1), busy: true })
    await Promise.resolve()
    assert.equal(finished, false)
    control.setState({ busy: false })
    await refreshing
    assert.equal(finished, true)
    assert.deepEqual(control.calls[1], {
      action: 'getAttribute',
      selector: REFRESH,
      options: { value: 'data-reconciliation-revision' },
    })
    assert.equal(
      control.calls.at(-1).selector,
      `${REFRESH}[data-reconciliation-revision="${Number(initialRevision) + 1}"]:not(:disabled)`
    )
    for (const { action, options } of control.calls)
      if (action !== 'getAttribute') assert.equal(options.timeoutMs, 60_000)
  }
)

test('reads its baseline after an already-running reconciliation finishes', async () => {
  const control = inventoryControl('3')
  control.setState({ busy: true })
  const refreshing = refreshPluginInventory(control)
  await Promise.resolve()
  assert.equal(control.calls.length, 1)
  control.setState({ busy: false, revision: '4' })
  await vi.waitFor(() => assert.equal(control.calls.length, 4))
  assert.equal(
    control.calls.at(-1).selector,
    `${REFRESH}[data-reconciliation-revision="5"]:not(:disabled)`
  )
  control.setState({ busy: false, revision: '5' })
  await refreshing
  for (const { action, options } of control.calls)
    if (action !== 'getAttribute') assert.equal(options.timeoutMs, 10_000)
})

test.each(['', '-1', '1.5', 'not-a-number', undefined])(
  'rejects an invalid reconciliation revision before refreshing: %s',
  async revision => {
    const control = inventoryControl(revision)
    await assert.rejects(
      refreshPluginInventory(control),
      /valid non-negative reconciliation revision/
    )
    assert.ok(control.calls.every(({ action }) => action !== 'clickWhenEnabled'))
  }
)

test.each(['clickWhenEnabled', 'waitFor'])(
  'propagates a refresh %s failure without a fallback',
  async failedAction => {
    const control = inventoryControl('2')
    const original = control.command.bind(control)
    const failure = new Error('Inventory refresh did not settle')
    control.command = async (action, selector, options) => {
      if (
        action === failedAction &&
        (action !== 'waitFor' || selector.includes('data-reconciliation-revision'))
      )
        throw failure
      return original(action, selector, options)
    }
    await assert.rejects(refreshPluginInventory(control), error => error === failure)
  }
)
