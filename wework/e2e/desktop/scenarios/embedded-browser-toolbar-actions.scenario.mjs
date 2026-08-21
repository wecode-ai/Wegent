import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const RIGHT_PANEL_TOGGLE_SELECTOR =
  '[data-workspace-tab-portal-owner]:not([hidden]) [data-testid="toggle-right-workspace-panel-button"]'
const RIGHT_PANEL_EXPAND_SELECTOR = '[data-testid="toggle-right-workspace-panel-expanded-button"]'
const RIGHT_BROWSER_OPTION_SELECTOR = '[data-testid="right-workspace-browser-option"]'
const ACTIVE_BROWSER_PANEL_SELECTOR =
  ACTIVE_WORKBENCH_SELECTOR +
  ' [data-testid="right-workspace-panel"] div:not(.hidden) > [data-testid="workspace-browser-panel"]'
const BROWSER_INPUT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-url-input"]'
const BROWSER_MORE_BUTTON_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-more-button"]'
const FIND_ITEM_SELECTOR = '[data-testid="workspace-browser-find-item"]'
const FIND_BAR_SELECTOR = '[data-testid="workspace-browser-find-bar"]'
const FIND_INPUT_SELECTOR = '[data-testid="workspace-browser-find-input"]'
const FIND_COUNT_SELECTOR = '[data-testid="workspace-browser-find-count"]'
const FIND_CLOSE_SELECTOR = '[data-testid="workspace-browser-find-close-button"]'
const DEVICE_TOOLBAR_ITEM_SELECTOR = '[data-testid="workspace-browser-device-toolbar-item"]'
const DEVICE_TOOLBAR_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-toolbar"]'
const DEVICE_ROTATE_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-rotate-button"]'
const DEVICE_WIDTH_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-width-input"]'
const DEVICE_HEIGHT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-height-input"]'
const DEVICE_ZOOM_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-zoom-select"]'
const DEVICE_ZOOM_200_SELECTOR = '[data-testid="workspace-browser-device-zoom-select-option-200"]'
const DEVICE_RESIZE_LEFT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-resize-left"]'
const DEVICE_RESIZE_RIGHT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-resize-right"]'
const DEVICE_CLOSE_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-close-button"]'
const SETTINGS_ITEM_SELECTOR = '[data-testid="workspace-browser-settings-item"]'
const BROWSER_SETTINGS_PAGE_SELECTOR = '[data-testid="browser-settings-page"]'
const FIXTURE_PATH = '/embedded-browser-toolbar-actions-fixture'
const BRIDGE_RUNTIME_FILE = 'embedded-browser-bridge.json'
const BROWSER_LABEL = 'workspace-browser'
const FIXTURE_WORD = 'Fixture'

function fixtureHtml() {
  return [
    '<!doctype html>',
    '<html>',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>Embedded Browser Toolbar Fixture</title>',
    '  </head>',
    '  <body>',
    '    <h1>Embedded Browser Toolbar Fixture</h1>',
    '    <p>Fixture paragraph one.</p>',
    '    <p>Fixture paragraph two.</p>',
    '  </body>',
    '</html>',
  ].join('\n')
}

async function waitForBridgeIdentity(executorHome, timeoutMs) {
  const runtimePath = join(executorHome, 'runtime', BRIDGE_RUNTIME_FILE)
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(runtimePath, 'utf8').catch(() => '')
    if (content) {
      const record = JSON.parse(content)
      if (record.schemaVersion === 1 && record.address && record.token) {
        return { baseUrl: 'http://' + record.address, token: record.token }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for authenticated embedded browser bridge runtime')
}

async function callBridge(identity, payload, label = BROWSER_LABEL) {
  const response = await fetch(identity.baseUrl + '/browser', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + identity.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label, ...payload }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, 'Bridge HTTP failed: ' + JSON.stringify(body))
  assert.equal(body.ok, true, 'Bridge action failed: ' + JSON.stringify(body))
  return body.data
}

async function evaluateFindState(identity) {
  const result = await callBridge(identity, {
    action: 'evaluate',
    expression: 'window.__WEWORK_BROWSER_FIND__ ? window.__WEWORK_BROWSER_FIND__.state() : null',
    timeoutMs: 5_000,
  })
  assert.equal(result.ok, true, 'Find state evaluation failed: ' + JSON.stringify(result))
  return result.value
}

async function waitForFindMatches(identity, expected, timeoutMs, message) {
  const startedAt = Date.now()
  let lastState = null
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await evaluateFindState(identity)
    if (lastState?.matches === expected) return lastState
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}; last state=${JSON.stringify(lastState)}`)
}

async function evaluatePageNumber(identity, expression, message) {
  const result = await callBridge(identity, {
    action: 'evaluate',
    expression,
    timeoutMs: 5_000,
  })
  assert.equal(result.ok, true, `${message}: ${JSON.stringify(result)}`)
  return Number(result.value)
}

async function waitForPageNumber(identity, expression, expected, tolerance, timeoutMs, message) {
  const startedAt = Date.now()
  let lastValue = null
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await evaluatePageNumber(identity, expression, message)
    if (Math.abs(lastValue - expected) <= tolerance) return lastValue
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}; expected ~${expected}, last value=${lastValue}`)
}

async function waitForValue(control, selector, expected, timeoutMs, message) {
  const startedAt = Date.now()
  let lastValue = null
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await control.command('getValue', selector)
    if (lastValue === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}; last value=${lastValue}`)
}

async function waitForElementGone(control, selector, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const count = await control.command('getElementCount', selector)
    if (count === '0') return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

function assertFramesEqual(before, after) {
  assert.equal(before.length, 4, 'Inspector verification returned an invalid before frame')
  assert.equal(after.length, 4, 'Inspector verification returned an invalid after frame')
  before.forEach((value, index) => {
    assert.ok(
      Math.abs(value - after[index]) <= 0.5,
      `Opening the Inspector changed child WebView frame index ${index}: ${value} -> ${after[index]}`
    )
  })
}

export function createDesktopScenario({ executorHome, uiTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'GET' || url.pathname !== FIXTURE_PATH) return false
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fixtureHtml())
      return true
    },

    async verify(control) {
      const bridgeIdentity = await waitForBridgeIdentity(executorHome, uiTimeoutMs)
      const fixtureUrl = control.url + FIXTURE_PATH

      await control.command('waitFor', RIGHT_PANEL_TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', RIGHT_PANEL_TOGGLE_SELECTOR)
      await control.command('click', RIGHT_BROWSER_OPTION_SELECTOR)
      await control.command('waitFor', BROWSER_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })

      await callBridge(bridgeIdentity, { action: 'open', url: fixtureUrl, timeoutMs: 8_000 })
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureUrl,
        uiTimeoutMs,
        'The browser tab did not load the toolbar fixture'
      )

      if (process.platform === 'darwin') {
        for (const attempt of [1, 2]) {
          const inspector = JSON.parse(
            await control.command('verifyEmbeddedBrowserDetachedInspector', 'body', {
              value: BROWSER_LABEL,
              timeoutMs: uiTimeoutMs,
            })
          )
          assert.equal(
            inspector.visible,
            true,
            `The built-in browser Inspector did not open on attempt ${attempt}`
          )
          assert.ok(
            inspector.afterWindowCount > inspector.beforeWindowCount,
            `The built-in browser Inspector did not create a separate native window on attempt ${attempt}`
          )
          assert.ok(
            !inspector.closedVisible,
            `The detached Inspector window remained visible after close on attempt ${attempt}`
          )
          assertFramesEqual(inspector.beforeFrame, inspector.afterFrame)
        }
      }

      // --- Find in page ---
      await control.command('click', BROWSER_MORE_BUTTON_SELECTOR)
      await control.command('waitFor', FIND_ITEM_SELECTOR, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', FIND_ITEM_SELECTOR)
      await control.command('waitFor', FIND_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', FIND_INPUT_SELECTOR, { value: FIXTURE_WORD })
      // The fixture contains three visible occurrences of the word.
      {
        const startedAt = Date.now()
        let lastCount = null
        while (Date.now() - startedAt < uiTimeoutMs) {
          lastCount = await control.command('getValue', FIND_COUNT_SELECTOR)
          if (lastCount.includes('1 / 3')) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        assert.ok(
          lastCount.includes('1 / 3'),
          `The find bar did not report all three fixture matches; last count=${lastCount}`
        )
      }
      const initialFindState = await evaluateFindState(bridgeIdentity)
      assert.deepEqual(
        initialFindState,
        { query: FIXTURE_WORD, matches: 3, active: 1 },
        'The in-page find runtime did not highlight all fixture matches'
      )
      await control.command('press', FIND_INPUT_SELECTOR, { key: 'Enter' })
      const nextFindState = await evaluateFindState(bridgeIdentity)
      assert.equal(nextFindState.active, 2, 'Enter did not move to the next find match')
      await control.command('click', FIND_CLOSE_SELECTOR)
      await waitForFindMatches(
        bridgeIdentity,
        0,
        uiTimeoutMs,
        'Closing the find bar did not clear highlights'
      )

      // --- Device toolbar ---
      await control.command('click', BROWSER_MORE_BUTTON_SELECTOR)
      await control.command('waitFor', DEVICE_TOOLBAR_ITEM_SELECTOR, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', DEVICE_TOOLBAR_ITEM_SELECTOR)
      await control.command('waitFor', DEVICE_TOOLBAR_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForPageNumber(
        bridgeIdentity,
        'window.innerWidth',
        390,
        4,
        uiTimeoutMs,
        'The responsive preset did not emulate a 390px viewport'
      )
      await control.command('click', DEVICE_ROTATE_SELECTOR)
      await waitForPageNumber(
        bridgeIdentity,
        'window.innerWidth',
        844,
        4,
        uiTimeoutMs,
        'Rotating the device viewport did not emulate an 844px width'
      )
      await control.command('click', RIGHT_PANEL_EXPAND_SELECTOR)
      await control.command('fill', DEVICE_WIDTH_SELECTOR, { value: '800' })
      await control.command('fill', DEVICE_HEIGHT_SELECTOR, { value: '600' })
      await waitForValue(
        control,
        DEVICE_WIDTH_SELECTOR,
        '800',
        uiTimeoutMs,
        'The responsive device width did not update'
      )
      await control.command('click', DEVICE_ZOOM_SELECTOR)
      await control.command('click', DEVICE_ZOOM_200_SELECTOR)
      await control.command('waitFor', DEVICE_RESIZE_LEFT_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', DEVICE_RESIZE_RIGHT_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('drag', DEVICE_RESIZE_RIGHT_SELECTOR, {
        target: DEVICE_RESIZE_LEFT_SELECTOR,
      })
      await waitForValue(
        control,
        DEVICE_WIDTH_SELECTOR,
        '240',
        uiTimeoutMs,
        'Device resizing incorrectly included the 200% page zoom in pointer scaling'
      )
      await control.command('click', DEVICE_CLOSE_SELECTOR)
      await waitForElementGone(
        control,
        DEVICE_TOOLBAR_SELECTOR,
        uiTimeoutMs,
        'The device toolbar did not close'
      )

      // --- Browser settings navigation ---
      await control.command('click', BROWSER_MORE_BUTTON_SELECTOR)
      await control.command('waitFor', SETTINGS_ITEM_SELECTOR, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', SETTINGS_ITEM_SELECTOR)
      await control.command('waitFor', BROWSER_SETTINGS_PAGE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('navigate', 'body', { value: '/' })
    },
  }
}
