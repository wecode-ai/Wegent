import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { refreshPluginInventory } from '../e2e/desktop/modules/plugin-inventory-state.mjs'

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
