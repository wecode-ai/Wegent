import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { verifyTerminalHistory } from '../e2e/desktop/scenarios/background-terminals.scenario.mjs'

const marker = 'WEWORK_BACKGROUND_PROCESS_ONE'

function historyControl({
  stuck = false,
  missingTick = false,
  pendingOutput = false,
  advanceBeforeKey = false,
  staleAccessibility = false,
  stuckAccessibility = false,
  initialScrollback = true,
  missingFirstTick = false,
} = {}) {
  let row = initialScrollback ? 121 : 1
  let bottom = row
  let advanced = false
  let elapsed = 0
  const calls = []
  let pendingRow = null
  vi.spyOn(Date, 'now').mockImplementation(() => elapsed)
  const control = {
    calls,
    async command(action, selector, options = {}) {
      elapsed += 2000
      calls.push({ action, selector, options })
      if (action === 'getAttribute') {
        if (pendingRow !== null) {
          const transientRow = row + 4
          row = pendingRow
          pendingRow = null
          return String(transientRow)
        }
        return String(row)
      }
      if (action === 'getText') {
        return row === 1
          ? Array.from({ length: 12 }, (_, index) => `${marker}_TICK_${index + 1}`)
              .slice(missingFirstTick ? 1 : 0)
              .join('\n')
          : `${marker}_TICK_${row}`
      }
      if (action === 'nativePress') {
        if (advanceBeforeKey && !advanced && options.key === 'Shift+PageUp') {
          row += 80
          bottom = row
          advanced = true
        }
        const viewportBefore = String(row)
        if (options.key === 'Shift+PageUp' && !stuck) {
          const next = Math.max(1, row - 40)
          if (pendingOutput) pendingRow = next
          row = next
        }
        if (options.key === 'Shift+PageDown') row = Math.min(bottom, row + 40)
        return options.target
          ? JSON.stringify({
              attributeBefore: staleAccessibility ? '41' : viewportBefore,
              viewportBefore,
              viewportAfter: String(row),
            })
          : undefined
      }
      if (action === 'waitFor') {
        if (selector.endsWith(':not([aria-posinset="1"])')) {
          if (!initialScrollback) row = bottom = 41
          return
        }
        if (selector.includes('[aria-posinset="') && stuckAccessibility) {
          throw new Error('Accessibility viewport did not update')
        }
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

test('waits for backward movement when live output advances before page-up renders', async () => {
  const history = historyControl({ pendingOutput: true })
  await verifyTerminalHistory(history.control, 10000)
  assert.equal(history.control.calls.filter(call => call.options.key === 'Shift+PageUp').length, 3)
})

test('still fails when the restored initial output is missing', async () => {
  const history = historyControl({ missingTick: true })
  await assert.rejects(verifyTerminalHistory(history.control, 10000), /history is not visible/)
})

test('compares page-up against the viewport at the native key, after live output has advanced', async () => {
  const history = historyControl({ advanceBeforeKey: true })
  await verifyTerminalHistory(history.control, 10000)
  assert.equal(history.row(), 201)
  assert.equal(history.control.calls.filter(call => call.options.key === 'Shift+PageUp').length, 5)
})

test('uses the native viewport when the accessibility tree is behind at the key event', async () => {
  const history = historyControl({ staleAccessibility: true })
  await verifyTerminalHistory(history.control, 10000)
  assert.equal(history.row(), 121)
  assert.equal(history.control.calls.filter(call => call.options.key === 'Shift+PageUp').length, 3)
})

test('still fails when the accessibility viewport never reflects the native page-up', async () => {
  const history = historyControl({ stuckAccessibility: true })
  await assert.rejects(verifyTerminalHistory(history.control, 10000), /viewport did not update/)
})

test('waits for scrollback before scrolling away from live output', async () => {
  const history = historyControl({ initialScrollback: false })
  await verifyTerminalHistory(history.control, 10000)
  const wait = history.control.calls.findIndex(call =>
    call.selector.endsWith(':not([aria-posinset="1"])')
  )
  const key = history.control.calls.findIndex(call => call.action === 'nativePress')
  assert.ok(wait >= 0 && wait < key)
  assert.equal(history.row(), 41)
})

test('still fails when later ticks exist but the first output was lost', async () => {
  const history = historyControl({ missingFirstTick: true })
  await assert.rejects(
    verifyTerminalHistory(history.control, 10000),
    /Missing terminal output tick 1/
  )
})
