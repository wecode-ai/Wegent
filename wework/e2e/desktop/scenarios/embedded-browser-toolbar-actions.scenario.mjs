import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const RIGHT_PANEL_TOGGLE_SELECTOR =
  '[data-workspace-tab-portal-owner]:not([hidden]) [data-testid="toggle-right-workspace-panel-button"]'
const RIGHT_BROWSER_OPTION_SELECTOR = '[data-testid="right-workspace-browser-option"]'
const ACTIVE_BROWSER_PANEL_SELECTOR =
  ACTIVE_WORKBENCH_SELECTOR +
  ' [data-testid="right-workspace-panel"] div:not(.hidden) > [data-testid="workspace-browser-panel"]'
const BROWSER_INPUT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-url-input"]'
const BROWSER_MORE_BUTTON_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-more-button"]'
const FIND_ITEM_SELECTOR = '[data-testid="workspace-browser-find-item"]'
const FIND_BAR_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-find-bar"]'
const FIND_INPUT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-find-input"]'
const FIND_COUNT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-find-count"]'
const FIND_CLOSE_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-find-close-button"]'
const ZOOM_LABEL_SELECTOR = '[data-testid="workspace-browser-zoom-label"]'
const ZOOM_IN_SELECTOR = '[data-testid="workspace-browser-zoom-in-button"]'
const ZOOM_OUT_SELECTOR = '[data-testid="workspace-browser-zoom-out-button"]'
const ZOOM_BANNER_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-zoom-banner"]'
const DEVICE_TOOLBAR_ITEM_SELECTOR = '[data-testid="workspace-browser-device-toolbar-item"]'
const DEVICE_TOOLBAR_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-toolbar"]'
const DEVICE_ROTATE_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-device-rotate-button"]'
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
      await waitForValue(
        control,
        FIND_COUNT_SELECTOR,
        '1 / 3',
        uiTimeoutMs,
        'The find bar did not report all three fixture matches'
      )
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
      const clearedFindState = await evaluateFindState(bridgeIdentity)
      assert.equal(clearedFindState.matches, 0, 'Closing the find bar did not clear highlights')

      // --- Zoom ---
      await control.command('click', BROWSER_MORE_BUTTON_SELECTOR)
      await waitForValue(
        control,
        ZOOM_LABEL_SELECTOR,
        '100%',
        uiTimeoutMs,
        'The zoom row did not start at 100%'
      )
      await control.command('click', ZOOM_IN_SELECTOR)
      await waitForValue(
        control,
        ZOOM_LABEL_SELECTOR,
        '110%',
        uiTimeoutMs,
        'Zoom in did not step to the next ladder level'
      )
      await control.command('waitFor', ZOOM_BANNER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', ZOOM_OUT_SELECTOR)
      await waitForValue(
        control,
        ZOOM_LABEL_SELECTOR,
        '100%',
        uiTimeoutMs,
        'Zoom out did not return to 100%'
      )

      // --- Device toolbar ---
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
