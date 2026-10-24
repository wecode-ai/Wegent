import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { refreshPluginInventory } from '../e2e/desktop/modules/plugin-inventory-state.mjs'
import { refreshWithOccupiedPluginRuntime } from '../e2e/desktop/modules/plugin-runtime-path-fixture.mjs'

const REFRESH = '[data-testid="plugins-refresh-button"]'
const NOTICE = '[data-testid="plugin-operation-notice"]'
const OCCUPIED_ERROR =
  'Plugin reconciliation failed for recovery-occupied: PLUGIN_RUNTIME_METADATA_FAILED'
const FIXTURE = { slug: 'recovery-occupied' }

function inventoryControl() {
  const calls = []
  const waiting = []
  const state = { busy: false, revision: '0', notice: null }
  const settle = () => {
    for (const waiter of [...waiting]) {
      const { selector, options } = waiter
      if (selector.startsWith(REFRESH)) {
        const target = selector.match(/data-reconciliation-revision="(\d+)"/)?.[1]
        if (state.busy || (target !== undefined && state.revision !== target)) continue
      } else if (options.visible === false) {
        if (state.notice) continue
      } else if (state.notice?.kind !== 'error' || !state.notice.message.includes(options.text)) {
        continue
      }
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
  return {
    calls,
    setState(next) {
      Object.assign(state, next)
      settle()
    },
    failPendingWaits(error) {
      for (const waiter of waiting.splice(0)) waiter.reject(error)
    },
    async command(action, selector, options = {}) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') return state.revision
      if (action === 'clickIfPresent') {
        state.notice = null
        settle()
        return ''
      }
      if (action === 'clickWhenEnabled') {
        assert.equal(state.busy, false)
        state.busy = true
        return ''
      }
      if (action === 'waitFor') {
        await new Promise((resolve, reject) => {
          waiting.push({ selector, options, resolve, reject })
          settle()
        })
        return ''
      }
      throw new Error(`Unexpected inventory command: ${action}`)
    },
  }
}

test('waits for this refresh to reject the occupied fixture and finish its busy state', async () => {
  const control = inventoryControl()
  control.setState({ notice: { kind: 'error', message: OCCUPIED_ERROR } })
  let finished = false
  const refreshing = refreshWithOccupiedPluginRuntime(control, FIXTURE, 60_000).then(() => {
    finished = true
  })
  await vi.waitFor(() => assert.equal(control.calls.length, 6))
  // A previous notice and the catalog-to-reconciliation gap cannot finish this refresh.
  control.setState({ busy: false })
  await Promise.resolve()
  assert.equal(finished, false)
  control.setState({ busy: true, notice: { kind: 'error', message: OCCUPIED_ERROR } })
  await vi.waitFor(() => assert.equal(control.calls.length, 7))
  assert.equal(finished, false)
  control.setState({ busy: false })
  await refreshing
  assert.equal(finished, true)
  assert.equal(control.calls[5].selector, `${NOTICE}[data-notice-kind="error"]`)
  assert.equal(control.calls[5].options.text, OCCUPIED_ERROR)
  assert.equal(control.calls.at(-1).action, 'getAttribute')
  for (const { action, options } of control.calls) {
    if (action === 'waitFor' || action === 'clickWhenEnabled') {
      assert.equal(options.timeoutMs, 60_000)
    }
  }
})

test.each([
  { busy: false, revision: '1', notice: { kind: 'success', message: 'Reconciled' } },
  {
    busy: false,
    notice: {
      kind: 'error',
      message: 'Plugin reconciliation failed for another-plugin: PLUGIN_RUNTIME_METADATA_FAILED',
    },
  },
  {
    busy: false,
    notice: {
      kind: 'error',
      message: 'Plugin reconciliation failed for recovery-occupied: offline',
    },
  },
])('rejects an outcome other than the controlled occupied-runtime error: %j', async outcome => {
  const control = inventoryControl()
  const refreshing = refreshWithOccupiedPluginRuntime(control, FIXTURE, 60_000)
  await vi.waitFor(() => assert.equal(control.calls.length, 6))
  control.setState(outcome)
  const timeout = new Error('Expected occupied-runtime notice was not observed')
  const rejected = assert.rejects(refreshing, error => error === timeout)
  control.failPendingWaits(timeout)
  await rejected
})

test('does not count an error notice as a successful inventory refresh', async () => {
  const control = inventoryControl()
  const refreshing = refreshPluginInventory(control, 60_000)
  await vi.waitFor(() => assert.equal(control.calls.length, 4))
  control.setState({ busy: false, notice: { kind: 'error', message: OCCUPIED_ERROR } })
  const timeout = new Error('Successful reconciliation revision was not observed')
  const rejected = assert.rejects(refreshing, error => error === timeout)
  control.failPendingWaits(timeout)
  await rejected
})

test('rejects a successful revision when expecting an occupied-runtime failure', async () => {
  const control = inventoryControl()
  const refreshing = refreshWithOccupiedPluginRuntime(control, FIXTURE, 60_000)
  const rejected = assert.rejects(refreshing, /must not be acknowledged as a successful/)
  await vi.waitFor(() => assert.equal(control.calls.length, 6))
  control.setState({
    busy: false,
    revision: '1',
    notice: { kind: 'error', message: OCCUPIED_ERROR },
  })
  await rejected
})
