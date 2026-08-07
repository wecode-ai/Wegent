import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const RIGHT_PANEL_TOGGLE_SELECTOR =
  '[data-workspace-tab-portal-owner]:not([hidden]) [data-testid="toggle-right-workspace-panel-button"]'
const RIGHT_BROWSER_OPTION_SELECTOR = '[data-testid="right-workspace-browser-option"]'
const RIGHT_CHAT_OPTION_SELECTOR = '[data-testid="right-workspace-chat-option"]'
const RIGHT_TERMINAL_OPTION_SELECTOR = '[data-testid="right-workspace-terminal-option"]'
const BROWSER_INPUT_SELECTOR =
  ACTIVE_WORKBENCH_SELECTOR + ' [data-testid="workspace-browser-url-input"]'
const FIRST_BROWSER_TAB_SELECTOR = '[data-testid="right-workspace-browser-tab-1"]'
const FIRST_BROWSER_TAB_CLOSE_SELECTOR =
  FIRST_BROWSER_TAB_SELECTOR + ' [data-testid="right-workspace-browser-tab-1-close-button"]'
const RIGHT_WORKSPACE_NEW_TAB_SELECTOR = '[data-testid="right-workspace-new-tab-button"]'
const RIGHT_WORKSPACE_TABBAR_SELECTOR = '[data-testid="right-workspace-tabbar"]'
const FIXTURE_A_PATH = '/embedded-browser-multi-tabs-a'
const FIXTURE_B_PATH = '/embedded-browser-multi-tabs-b'
const FIXTURE_A_TEXT = 'Embedded Browser Multi Tab A'
const FIXTURE_B_TEXT = 'Embedded Browser Multi Tab B'
const BRIDGE_RUNTIME_FILE = 'embedded-browser-bridge.json'
const BROWSER_LABEL = 'workspace-browser'

function fixtureHtml(title, text) {
  return [
    '<!doctype html>',
    '<html>',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>' + title + '</title>',
    '    <style>',
    '      body { font-family: system-ui, sans-serif; margin: 16px; }',
    '      h1 { font-size: 24px; margin: 0; }',
    '    </style>',
    '  </head>',
    '  <body>',
    '    <h1>' + text + '</h1>',
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
        return { baseUrl: 'http://' + record.address, token: record.token, runtimePath }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for authenticated embedded browser bridge runtime')
}

async function callBridge(identity, payload) {
  const response = await fetch(identity.baseUrl + '/browser', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + identity.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label: BROWSER_LABEL, ...payload }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, 'Bridge HTTP failed: ' + JSON.stringify(body))
  assert.equal(body.ok, true, 'Bridge action failed: ' + JSON.stringify(body))
  return body.data
}

async function waitForValue(control, selector, expected, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if ((await control.command('getValue', selector)) === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function waitForSnapshot(control, predicate, message, timeoutMs, selector = 'body') {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', selector))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    message + (lastSnapshot ? '; last testIds=' + JSON.stringify(lastSnapshot.testIds) : '')
  )
}

export function createDesktopScenario({ executorHome, uiTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'GET') return false
      if (url.pathname === FIXTURE_A_PATH) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(fixtureHtml(FIXTURE_A_TEXT, FIXTURE_A_TEXT))
        return true
      }
      if (url.pathname === FIXTURE_B_PATH) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(fixtureHtml(FIXTURE_B_TEXT, FIXTURE_B_TEXT))
        return true
      }
      return false
    },

    async verify(control) {
      const bridgeIdentity = await waitForBridgeIdentity(executorHome, uiTimeoutMs)
      const fixtureAUrl = control.url + FIXTURE_A_PATH
      const fixtureBUrl = control.url + FIXTURE_B_PATH

      await control.command('waitFor', RIGHT_PANEL_TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', RIGHT_PANEL_TOGGLE_SELECTOR)
      await control.command('click', RIGHT_BROWSER_OPTION_SELECTOR)
      await control.command('waitFor', BROWSER_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })

      await callBridge(bridgeIdentity, { action: 'open', url: fixtureAUrl, timeoutMs: 8000 })
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureAUrl,
        uiTimeoutMs,
        'The first browser tab did not load the A fixture'
      )
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('right-workspace-browser-tab-1') &&
          !snapshot.testIds.includes('right-workspace-browser-tab-2'),
        'The right workspace did not start with one browser tab',
        uiTimeoutMs,
        'body'
      )

      await control.command('click', RIGHT_WORKSPACE_NEW_TAB_SELECTOR)
      await control.command('click', RIGHT_CHAT_OPTION_SELECTOR)
      await control.command('click', RIGHT_WORKSPACE_NEW_TAB_SELECTOR)
      await control.command('click', RIGHT_TERMINAL_OPTION_SELECTOR)
      await control.command('click', RIGHT_WORKSPACE_NEW_TAB_SELECTOR)
      await control.command('click', RIGHT_BROWSER_OPTION_SELECTOR)
      const mixedTabsSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('right-workspace-browser-tab-1') &&
          snapshot.testIds.includes('right-workspace-browser-tab-2') &&
          snapshot.testIds.includes('right-workspace-terminal-tab') &&
          snapshot.testIds.some(testId => testId.startsWith('right-workspace-chat-tab-')),
        'Adding mixed workspace tabs did not create all four top-level tabs',
        uiTimeoutMs,
        RIGHT_WORKSPACE_TABBAR_SELECTOR
      )
      const mixedTabbarText = (
        await control.command('getText', RIGHT_WORKSPACE_TABBAR_SELECTOR)
      ).replace(/\s+/g, '')
      const chatLabel = mixedTabbarText.includes('临时聊天') ? '临时聊天' : 'Temporarychat'
      const terminalLabel = mixedTabbarText.includes('终端') ? '终端' : 'Terminal'
      const newTabLabel = mixedTabbarText.endsWith('新选项卡') ? '新选项卡' : 'Newtab'
      const chatIndex = mixedTabbarText.indexOf(chatLabel)
      const terminalIndex = mixedTabbarText.indexOf(terminalLabel)
      const secondBrowserIndex = mixedTabbarText.lastIndexOf(newTabLabel)
      assert.ok(
        chatIndex > 0 && terminalIndex > chatIndex && secondBrowserIndex > terminalIndex,
        'Browser, chat, and terminal tabs were grouped instead of preserving insertion order: ' +
          mixedTabbarText
      )
      assert.equal(
        mixedTabsSnapshot.testIds.includes('browser-tab-strip'),
        false,
        'The browser rendered a nested tab strip instead of top-level workspace tabs'
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        '',
        uiTimeoutMs,
        'The newly added browser tab was not selected'
      )

      await callBridge(bridgeIdentity, { action: 'open', url: fixtureBUrl, timeoutMs: 8000 })
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureBUrl,
        uiTimeoutMs,
        'The second browser tab did not load the B fixture'
      )
      const secondTabText = await callBridge(bridgeIdentity, {
        action: 'inspect',
        options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
        timeoutMs: 5000,
      })
      assert.ok(
        secondTabText.inspectText.includes(FIXTURE_B_TEXT),
        'The second browser tab did not retain its own page state'
      )

      await control.command('click', FIRST_BROWSER_TAB_SELECTOR)
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureAUrl,
        uiTimeoutMs,
        'Switching back to the first browser tab did not restore its URL'
      )
      const firstTabText = await callBridge(bridgeIdentity, {
        action: 'inspect',
        options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
        timeoutMs: 5000,
      })
      assert.ok(
        firstTabText.inspectText.includes(FIXTURE_A_TEXT),
        'The first browser tab did not retain its own page state'
      )

      await control.command('hover', FIRST_BROWSER_TAB_SELECTOR)
      await control.command('click', FIRST_BROWSER_TAB_CLOSE_SELECTOR)
      await waitForSnapshot(
        control,
        snapshot =>
          !snapshot.testIds.includes('right-workspace-browser-tab-1') &&
          snapshot.testIds.includes('right-workspace-browser-tab-2'),
        'Closing the first browser tab did not leave the second top-level tab in place',
        uiTimeoutMs,
        'body'
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureBUrl,
        uiTimeoutMs,
        'Closing the first browser tab did not activate the remaining tab'
      )
      const remainingTabText = await callBridge(bridgeIdentity, {
        action: 'inspect',
        options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
        timeoutMs: 5000,
      })
      assert.ok(
        remainingTabText.inspectText.includes(FIXTURE_B_TEXT),
        'Closing the first browser tab lost the second tab page state'
      )

      await control.command('click', RIGHT_PANEL_TOGGLE_SELECTOR)
      await control.command('click', RIGHT_PANEL_TOGGLE_SELECTOR)
      await control.command('waitFor', BROWSER_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureBUrl,
        uiTimeoutMs,
        'Reopening the right workspace did not preserve the remaining browser tab'
      )
      await waitForSnapshot(
        control,
        snapshot =>
          !snapshot.testIds.includes('right-workspace-browser-tab-1') &&
          snapshot.testIds.includes('right-workspace-browser-tab-2'),
        'Reopening the right workspace did not preserve a single top-level browser tab',
        uiTimeoutMs,
        'body'
      )

      await callBridge(bridgeIdentity, { action: 'open', url: fixtureAUrl, timeoutMs: 8000 })
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureAUrl,
        uiTimeoutMs,
        'The reopened browser panel did not accept a fresh navigation'
      )
      const reopenedText = await callBridge(bridgeIdentity, {
        action: 'inspect',
        options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
        timeoutMs: 5000,
      })
      assert.ok(
        reopenedText.inspectText.includes(FIXTURE_A_TEXT),
        'The reopened browser panel did not render the fresh page'
      )
    },
  }
}
