import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { verifyTerminalHistory } from '../e2e/desktop/scenarios/background-terminals.scenario.mjs'

const marker = 'WEWORK_BACKGROUND_PROCESS_ONE'

function historyControl({
  stuck = false,
  missingTick = false,
  pendingOutput = false,
  untrusted = false,
} = {}) {
  let row = 121
  let lastRow = row
  let elapsed = 0
  const calls = []
  let samples = []
  let pages = 0
  vi.spyOn(Date, 'now').mockImplementation(() => elapsed)
  const control = {
    calls,
    async command(action, selector, options = {}) {
      elapsed += 2000
      calls.push({ action, selector, options })
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          nativeTerminalKeys: { current: { buffer: { viewportY: row - 1 } }, samples },
        })
      }
      if (action === 'getText') {
        return row === 1
          ? Array.from({ length: 12 }, (_, index) => `${marker}_TICK_${index + 1}`).join('\n')
          : `${marker}_TICK_${row}`
      }
      if (action === 'nativePress') {
        if (options.key === 'Shift+PageUp') {
          if (pendingOutput && pages === 0) {
            row += 80
            lastRow = row
          }
          const baseline = row - 1
          if (!stuck) row = Math.max(1, row - 40)
          samples = [
            {
              phase: 'native-event',
              event: { key: 'PageUp', isTrusted: !untrusted },
              buffer: { viewportY: baseline },
            },
            { phase: 'after-render-tick', key: 'Shift+PageUp', buffer: { viewportY: row - 1 } },
          ]
          pages += 1
        }
        if (options.key === 'Shift+PageDown') row = Math.min(lastRow, row + 40)
        return
      }
      if (action === 'waitFor') {
        if (options.text === `${marker}_TICK_12` && (row !== 1 || missingTick)) {
          throw new Error('Initial history is not visible')
        }
        return
      }
      throw new Error(`Unexpected action: ${action}`)
    },
  }
  return { control, elapsed: () => elapsed, row: () => row }
}

afterEach(() => vi.restoreAllMocks())

test('reads restored history when native page navigation takes more than one step timeout', async () => {
  const history = historyControl()
  await verifyTerminalHistory(history.control, 10000)
  assert.ok(history.elapsed() > 10000)
  assert.equal(history.row(), 121)
  assert.equal(history.control.calls.filter(call => call.options.key === 'Shift+PageUp').length, 3)
})

test('fails when a native page-up does not move the viewport', async () => {
  const history = historyControl({ stuck: true })
  await assert.rejects(verifyTerminalHistory(history.control, 10000), /did not move backwards/)
})

test('rejects paging without a trusted native key event', async () => {
  const history = historyControl({ untrusted: true })
  await assert.rejects(verifyTerminalHistory(history.control, 10000), /real native key event/)
})

test('compares positions at the native key event when output advances beyond the old baseline', async () => {
  const history = historyControl({ pendingOutput: true })
  await verifyTerminalHistory(history.control, 10000)
  assert.equal(history.control.calls.filter(call => call.options.key === 'Shift+PageUp').length, 5)
})

test('still fails when the restored initial output is missing', async () => {
  const history = historyControl({ missingTick: true })
  await assert.rejects(verifyTerminalHistory(history.control, 10000), /history is not visible/)
})
