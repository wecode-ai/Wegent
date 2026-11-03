import assert from 'node:assert/strict'
import { test } from 'vitest'
import { verifyHumanInteractionAcrossWindows } from '../e2e/desktop/modules/human-interaction-windows.mjs'

test('returns native focus to the main window after checking the second window', async () => {
  let mainFocused = false
  let routedWindow = 'main'
  const lock = { name: 'interaction:history:request' }
  const commandForWindow = async (window, action) => {
    if (action === 'getLocationOrigin') return 'http://127.0.0.1'
    if (action === 'readRuntimeTransportGate') return '{"reached":true}'
    if (action === 'getWebLocksSnapshot') {
      return JSON.stringify({ held: [lock], pending: window === 'main' ? [] : [lock] })
    }
    if (action === 'focusMainWindow') {
      assert.equal(window, 'main')
      mainFocused = true
    }
    return ''
  }
  const control = {
    readyCount: 1,
    command: (...args) => commandForWindow(routedWindow, ...args),
    commandForWindow,
    awaitReadyAfter: async () => ({ windowLabel: 'workspace-second' }),
    activateWindow: label => {
      routedWindow = label
    },
  }
  await verifyHumanInteractionAcrossWindows({
    control,
    page: 'inbox',
    question: 'Which rule?',
    answer: 'Keep the existing rule',
    captureScreenshot: async () => {},
  })
  assert.equal(routedWindow, 'main')
  assert.equal(mainFocused, true, 'Routing a control command does not focus the native window')
})
