import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CHECKPOINT_TASK_PROMPT } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_COMPOSER_SELECTOR =
  ACTIVE_WORKBENCH_SELECTOR + ' [data-testid="chat-message-input"][contenteditable="true"]'
const RIGHT_PANEL_TOGGLE_SELECTOR =
  '[data-workspace-tab-portal-owner]:not([hidden]) [data-testid="toggle-right-workspace-panel-button"]'
const RIGHT_NEW_TAB_CHAT_OPTION_SELECTOR =
  '[data-testid="right-workspace-new-tab-menu"] [data-testid="right-workspace-chat-option"]'
const RIGHT_NEW_TAB_TERMINAL_OPTION_SELECTOR =
  '[data-testid="right-workspace-new-tab-menu"] [data-testid="right-workspace-terminal-option"]'
const ACTIVE_BROWSER_PANEL_SELECTOR =
  ACTIVE_WORKBENCH_SELECTOR +
  ' [data-testid="right-workspace-panel"] div:not(.hidden) > [data-testid="workspace-browser-panel"]'
const ACTIVE_BROWSER_WEBVIEW_HOST_SELECTOR = '[data-testid="workspace-browser-electron-webview"]'
const BROWSER_INPUT_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-url-input"]'
const FIRST_BROWSER_TAB_SELECTOR = '[data-testid="right-workspace-browser-tab-1"]'
const FIRST_BROWSER_LOADING_ICON_SELECTOR =
  FIRST_BROWSER_TAB_SELECTOR + ' [data-testid="right-workspace-browser-tab-1-loading-icon"]'
const FIRST_BROWSER_TAB_CLOSE_SELECTOR =
  FIRST_BROWSER_TAB_SELECTOR + ' [data-testid="right-workspace-browser-tab-1-close-button"]'
const SECOND_BROWSER_TAB_SELECTOR = '[data-testid="right-workspace-browser-tab-2"]'
const SECOND_BROWSER_TAB_CLOSE_SELECTOR =
  SECOND_BROWSER_TAB_SELECTOR + ' [data-testid="right-workspace-browser-tab-2-close-button"]'
const BROWSER_RELOAD_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-reload-button"]'
const BROWSER_NAVIGATION_ERROR_SELECTOR =
  ACTIVE_BROWSER_PANEL_SELECTOR + ' [data-testid="workspace-browser-navigation-error"]'
const RIGHT_WORKSPACE_NEW_TAB_SELECTOR = '[data-testid="right-workspace-new-tab-button"]'
const RIGHT_WORKSPACE_TABBAR_SELECTOR = '[data-testid="right-workspace-tabbar"]'
const WORKBENCH_BROWSER_LABEL_SELECTOR =
  ACTIVE_WORKBENCH_SELECTOR +
  ' [data-testid="desktop-workbench-content"][data-embedded-browser-label]'
const FIXTURE_A_PATH = '/embedded-browser-multi-tabs-a'
const FIXTURE_B_PATH = '/embedded-browser-multi-tabs-b'
const NAVIGATION_FAILURE_PATH = '/embedded-browser-navigation-failure'
const FIXTURE_A_TEXT = 'Embedded Browser Multi Tab A'
const FIXTURE_B_TEXT = 'Embedded Browser Multi Tab B'
const BRIDGE_RUNTIME_FILE = 'embedded-browser-bridge.json'
const BROWSER_LABEL = 'workspace-browser'
const OPEN_BROWSER_WHILE_CLOSED_KEY =
  process.platform === 'win32' ? 'Control+Shift+B' : 'Meta+Shift+B'
const OPEN_BROWSER_WHILE_OPEN_KEY = process.platform === 'win32' ? 'Control+T' : 'Meta+T'

function fixtureHtml(title, text, popupUrl = null, autoPopup = false) {
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
    popupUrl ? '    <a id="popup-link" href="' + popupUrl + '" target="_blank">Open B</a>' : null,
    autoPopup && popupUrl
      ? '    <script>window.open(' + JSON.stringify(popupUrl) + ', "_blank")</script>'
      : null,
    '  </body>',
    '</html>',
  ]
    .filter(line => line !== null)
    .join('\n')
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

async function callBridge(identity, payload, label = BROWSER_LABEL) {
  const requestTimeoutMs = Math.max(Number(payload.timeoutMs ?? 0), 15_000) + 2_000
  const response = await fetch(identity.baseUrl + '/browser', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + identity.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label, ...payload }),
    signal: AbortSignal.timeout(requestTimeoutMs),
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

async function waitForBridgeActiveLabel(identity, label, expected, timeoutMs, message) {
  const startedAt = Date.now()
  let lastLabel = null
  while (Date.now() - startedAt < timeoutMs) {
    const status = await callBridge(identity, { action: 'status' }, label)
    lastLabel = status.label
    if (status.label === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message + (lastLabel ? '; last label=' + lastLabel : ''))
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

async function waitForRuntimeTaskId(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const taskId = snapshot.workbench?.currentRuntimeTask?.taskId
    if (taskId) return taskId
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the browser-owning pane to become a local task')
}

async function waitForBrowserLabel(control, expected, timeoutMs) {
  const startedAt = Date.now()
  let actual = null
  while (Date.now() - startedAt < timeoutMs) {
    actual = await control.command('getAttribute', WORKBENCH_BROWSER_LABEL_SELECTOR, {
      value: 'data-embedded-browser-label',
    })
    if (actual === expected) return actual
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for browser label ${expected}; last label=${actual}`)
}

async function waitForElementMetricsSample(control, timeoutMs) {
  const startedAt = Date.now()
  let sample = null
  while (Date.now() - startedAt < timeoutMs) {
    sample = JSON.parse(await control.command('getElementMetricsSample', 'body'))
    if (sample.done) return sample
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    'Timed out waiting for browser element metrics sample' +
      (sample ? '; frames=' + sample.frames.length : '')
  )
}

async function waitForBridgeText(identity, label, text, timeoutMs, message) {
  const startedAt = Date.now()
  let lastInspectText = null
  let lastPageState = null
  while (Date.now() - startedAt < timeoutMs) {
    const page = await callBridge(
      identity,
      {
        action: 'inspect',
        options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
        timeoutMs: 5000,
      },
      label
    ).catch(() => null)
    if (page?.inspectText?.includes(text)) return page
    lastInspectText = page?.inspectText ?? null
    lastPageState = await callBridge(identity, { action: 'pageState' }, label).catch(() => null)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `${message}; label=${label}; pageState=${JSON.stringify(lastPageState)}; ` +
      `inspect=${JSON.stringify(lastInspectText?.slice(0, 240) ?? null)}`
  )
}

function fixtureTextFromInspect(inspectText) {
  if (inspectText.includes(FIXTURE_A_TEXT)) return FIXTURE_A_TEXT
  if (inspectText.includes(FIXTURE_B_TEXT)) return FIXTURE_B_TEXT
  throw new Error(`Expected a loaded browser fixture; inspect=${JSON.stringify(inspectText)}`)
}

async function captureMigrationScreenshot(captureScreenshot, control, resultDir) {
  const screenshotPath = join(resultDir, 'embedded-browser-migration-page-retained.png')
  await captureScreenshot(
    control,
    'embedded-browser-migration-page-retained.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  const screenshotBytes = await readFile(screenshotPath)
  assert.equal(
    screenshotBytes.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
    'Migration screenshot is not a PNG file'
  )
}

export function createDesktopScenario({ captureScreenshot, executorHome, resultDir, uiTimeoutMs }) {
  let fixtureAResponseGate = null
  let fixtureARequestStartCount = 0
  let fixtureAResponseCount = 0

  const holdNextFixtureAResponse = () => {
    let release
    fixtureAResponseGate = new Promise(resolve => {
      release = resolve
    })
    return () => release?.()
  }

  const waitForFixtureAResponseCount = async expected => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < uiTimeoutMs) {
      if (fixtureAResponseCount >= expected) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for fixture A response ${expected}`)
  }

  const waitForFixtureARequestStartCount = async expected => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < uiTimeoutMs) {
      if (fixtureARequestStartCount >= expected) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for fixture A request ${expected}`)
  }

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'GET') return false
      if (url.pathname === FIXTURE_A_PATH) {
        const html = fixtureHtml(
          FIXTURE_A_TEXT,
          FIXTURE_A_TEXT,
          url.origin + FIXTURE_B_PATH,
          url.searchParams.get('popup') === '1'
        )
        const responseGate = fixtureAResponseGate
        fixtureAResponseGate = null
        fixtureARequestStartCount += 1
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.write(html.slice(0, 120))
        if (responseGate) {
          await responseGate
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        response.end(html.slice(120))
        fixtureAResponseCount += 1
        return true
      }
      if (url.pathname === FIXTURE_B_PATH) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(fixtureHtml(FIXTURE_B_TEXT, FIXTURE_B_TEXT))
        return true
      }
      if (url.pathname === NAVIGATION_FAILURE_PATH) {
        response.writeHead(302, { location: NAVIGATION_FAILURE_PATH })
        response.end()
        return true
      }
      return false
    },

    async verify(control) {
      const bridgeIdentity = await waitForBridgeIdentity(executorHome, uiTimeoutMs)
      const fixtureAUrl = control.url + FIXTURE_A_PATH
      const fixtureBUrl = control.url + FIXTURE_B_PATH
      const navigationFailureUrl = control.url + NAVIGATION_FAILURE_PATH

      await control.command('waitFor', RIGHT_PANEL_TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      assert.equal(
        await control.command('getAttribute', '[data-testid="right-workspace-panel-shell"]', {
          value: 'aria-hidden',
        }),
        'true',
        'The browser shortcut checkpoint did not start with the right panel closed'
      )
      await control.command('press', 'body', { key: OPEN_BROWSER_WHILE_CLOSED_KEY })
      await control.command('waitFor', BROWSER_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })

      await callBridge(bridgeIdentity, { action: 'open', url: fixtureAUrl, timeoutMs: 8000 })
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureAUrl,
        uiTimeoutMs,
        'The first browser tab did not load the A fixture'
      )
      await waitForFixtureAResponseCount(1)
      const expectedReloadRequestStartCount = fixtureARequestStartCount + 1
      const releaseReloadResponse = holdNextFixtureAResponse()
      await control.command('click', BROWSER_RELOAD_SELECTOR)
      try {
        await waitForFixtureARequestStartCount(expectedReloadRequestStartCount)
        await control.command('waitFor', FIRST_BROWSER_LOADING_ICON_SELECTOR, {
          timeoutMs: uiTimeoutMs,
        })
      } finally {
        releaseReloadResponse()
      }
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('right-workspace-browser-tab-1-loading-icon'),
        'The first browser tab did not restore its favicon after reloading',
        uiTimeoutMs,
        FIRST_BROWSER_TAB_SELECTOR
      )
      await control.command('fill', BROWSER_INPUT_SELECTOR, { value: navigationFailureUrl })
      await control.command('submit', BROWSER_INPUT_SELECTOR)
      await control.command('waitFor', BROWSER_NAVIGATION_ERROR_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      const navigationFailureText = await control.command(
        'getText',
        BROWSER_NAVIGATION_ERROR_SELECTOR
      )
      assert.match(
        navigationFailureText,
        /页面无法打开|Page couldn't be opened/,
        'The browser did not explain the navigation failure'
      )
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('right-workspace-browser-tab-1-loading-icon'),
        'The browser tab kept loading after navigation failed',
        uiTimeoutMs,
        FIRST_BROWSER_TAB_SELECTOR
      )
      await control.command('fill', BROWSER_INPUT_SELECTOR, { value: fixtureAUrl })
      const expectedRecoveryRequestStartCount = fixtureARequestStartCount + 1
      const releaseRecoveryResponse = holdNextFixtureAResponse()
      await control.command('submit', BROWSER_INPUT_SELECTOR)
      try {
        await waitForFixtureARequestStartCount(expectedRecoveryRequestStartCount)
        await control.command('waitFor', FIRST_BROWSER_LOADING_ICON_SELECTOR, {
          timeoutMs: uiTimeoutMs,
        })
      } finally {
        releaseRecoveryResponse()
      }
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('right-workspace-browser-tab-1-loading-icon'),
        'The browser tab kept loading after navigation recovery',
        uiTimeoutMs,
        FIRST_BROWSER_TAB_SELECTOR
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureAUrl,
        uiTimeoutMs,
        'The browser did not recover after a failed navigation'
      )
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('workspace-browser-navigation-error'),
        'The browser kept showing the navigation error after recovery',
        uiTimeoutMs,
        ACTIVE_BROWSER_PANEL_SELECTOR
      )
      const firstBrowserLabel = (await callBridge(bridgeIdentity, { action: 'status' })).label
      const secondBrowserLabel = firstBrowserLabel + '-2'
      await control.command('press', 'body', { key: OPEN_BROWSER_WHILE_CLOSED_KEY })
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('right-workspace-browser-tab-1') &&
          !snapshot.testIds.includes('right-workspace-browser-tab-2'),
        'The closed-panel browser shortcut fired again while the right panel was open',
        uiTimeoutMs,
        'body'
      )

      await control.command('click', RIGHT_WORKSPACE_NEW_TAB_SELECTOR)
      await control.command('click', RIGHT_NEW_TAB_CHAT_OPTION_SELECTOR)
      await control.command('click', RIGHT_WORKSPACE_NEW_TAB_SELECTOR)
      await control.command('click', RIGHT_NEW_TAB_TERMINAL_OPTION_SELECTOR)
      await control.command('press', 'body', { key: OPEN_BROWSER_WHILE_OPEN_KEY })
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
      await waitForBridgeActiveLabel(
        bridgeIdentity,
        firstBrowserLabel,
        secondBrowserLabel,
        uiTimeoutMs,
        'The embedded browser bridge did not route to the newly added tab'
      )

      await callBridge(
        bridgeIdentity,
        { action: 'open', url: fixtureBUrl, timeoutMs: 8000 },
        firstBrowserLabel
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureBUrl,
        uiTimeoutMs,
        'The second browser tab did not load the B fixture'
      )
      const secondTabText = await callBridge(
        bridgeIdentity,
        {
          action: 'inspect',
          options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
          timeoutMs: 5000,
        },
        firstBrowserLabel
      )
      assert.ok(
        secondTabText.inspectText.includes(FIXTURE_B_TEXT),
        'The second browser tab did not retain its own page state'
      )

      await control.command('click', FIRST_BROWSER_TAB_SELECTOR)
      await waitForBridgeActiveLabel(
        bridgeIdentity,
        firstBrowserLabel,
        firstBrowserLabel,
        uiTimeoutMs,
        'Switching back to the first browser tab did not update bridge routing'
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureAUrl,
        uiTimeoutMs,
        'Switching back to the first browser tab did not restore its URL'
      )
      const firstTabText = await callBridge(
        bridgeIdentity,
        {
          action: 'inspect',
          options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
          timeoutMs: 5000,
        },
        firstBrowserLabel
      )
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
      await waitForBridgeActiveLabel(
        bridgeIdentity,
        firstBrowserLabel,
        secondBrowserLabel,
        uiTimeoutMs,
        'Closing the first browser tab did not route the bridge to the remaining tab'
      )
      const remainingTabText = await callBridge(
        bridgeIdentity,
        {
          action: 'inspect',
          options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
          timeoutMs: 5000,
        },
        firstBrowserLabel
      )
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

      await callBridge(
        bridgeIdentity,
        { action: 'open', url: fixtureAUrl, timeoutMs: 8000 },
        firstBrowserLabel
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureAUrl,
        uiTimeoutMs,
        'The reopened browser panel did not accept a fresh navigation'
      )
      const reopenedText = await callBridge(
        bridgeIdentity,
        {
          action: 'inspect',
          options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
          timeoutMs: 5000,
        },
        firstBrowserLabel
      )
      assert.ok(
        reopenedText.inspectText.includes(FIXTURE_A_TEXT),
        'The reopened browser panel did not render the fresh page'
      )

      await callBridge(
        bridgeIdentity,
        { action: 'open', url: fixtureAUrl + '?popup=1', timeoutMs: 8000 },
        firstBrowserLabel
      )
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.filter(testId => /^right-workspace-browser-tab-\d+$/.test(testId))
            .length >= 2,
        'A blank-target popup did not open another browser tab',
        uiTimeoutMs,
        RIGHT_WORKSPACE_TABBAR_SELECTOR
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureBUrl,
        uiTimeoutMs,
        'The popup browser tab did not load the linked page'
      )
      const popupTabText = await callBridge(bridgeIdentity, {
        action: 'inspect',
        options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
        timeoutMs: 5000,
      })
      assert.ok(
        popupTabText.inspectText.includes(FIXTURE_B_TEXT),
        'The popup browser tab did not retain the linked page state'
      )
      await control.command('hover', SECOND_BROWSER_TAB_SELECTOR)
      await control.command('click', SECOND_BROWSER_TAB_CLOSE_SELECTOR)
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.filter(testId => /^right-workspace-browser-tab-\d+$/.test(testId))
            .length === 1 && !snapshot.testIds.includes('right-workspace-browser-tab-2'),
        'Closing the background browser tab did not leave one loaded page',
        uiTimeoutMs,
        RIGHT_WORKSPACE_TABBAR_SELECTOR
      )
      await waitForValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureBUrl,
        uiTimeoutMs,
        'The loaded popup page was not preserved before task creation'
      )
      const activeTemporaryLabel = (
        await callBridge(bridgeIdentity, { action: 'status' }, firstBrowserLabel)
      ).label
      assert.ok(
        activeTemporaryLabel === firstBrowserLabel ||
          activeTemporaryLabel.startsWith(firstBrowserLabel + '-'),
        'The active browser tab was not scoped to the temporary conversation label'
      )
      const activeTemporaryText = await callBridge(
        bridgeIdentity,
        {
          action: 'inspect',
          options: { includeTextBlocks: true, interactiveOnly: false, maxNodes: 40 },
          timeoutMs: 5000,
        },
        activeTemporaryLabel
      )
      const activeExpectedText = fixtureTextFromInspect(activeTemporaryText.inspectText)
      const activeTemporaryPageState = await callBridge(
        bridgeIdentity,
        { action: 'pageState' },
        activeTemporaryLabel
      )
      const attachmentRequestCountBeforeTask = (
        (await readFile(join(resultDir, 'app.log'), 'utf8')).match(
          /\[embedded-browser\] webview attachment requested/g
        ) ?? []
      ).length
      control.setScenario('checkpoint_task')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
        value: CHECKPOINT_TASK_PROMPT,
      })
      await control.command('startElementMetricsSampling', ACTIVE_BROWSER_WEBVIEW_HOST_SELECTOR, {
        value: '2000',
        visible: true,
      })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      const taskId = await waitForRuntimeTaskId(control, uiTimeoutMs)
      console.log(`[browser-multi-tabs] task created: ${taskId}`)
      const expectedMigratedBaseLabel =
        'workspace-browser-' + taskId.replace(/[^a-zA-Z0-9_-]/g, '-')
      const migratedBaseLabel = await waitForBrowserLabel(
        control,
        expectedMigratedBaseLabel,
        uiTimeoutMs
      )
      console.log(`[browser-multi-tabs] renderer label migrated: ${migratedBaseLabel}`)
      const elementMetricsSample = await waitForElementMetricsSample(control, uiTimeoutMs)
      await writeFile(
        join(resultDir, 'embedded-browser-migration-element-metrics.json'),
        JSON.stringify(elementMetricsSample, null, 2) + '\n',
        'utf8'
      )
      const disconnectedFrames = elementMetricsSample.frames.filter(frame => !frame.connected)
      assert.equal(
        disconnectedFrames.length,
        0,
        `Creating the first task remounted the browser webview for ` +
          `${disconnectedFrames.length} frames`
      )
      const sampledWidths = elementMetricsSample.frames.map(frame => frame.width)
      const sampledLefts = elementMetricsSample.frames.map(frame => frame.left)
      const minimumWidth = Math.min(...sampledWidths)
      const maximumWidth = Math.max(...sampledWidths)
      const minimumLeft = Math.min(...sampledLefts)
      const maximumLeft = Math.max(...sampledLefts)
      console.log(
        '[browser-multi-tabs] migration webview bounds: ' +
          `width=${minimumWidth}..${maximumWidth}, left=${minimumLeft}..${maximumLeft}`
      )
      assert.ok(
        maximumWidth - minimumWidth <= 1,
        `Creating the first task resized the browser webview: ${minimumWidth}..${maximumWidth}`
      )
      assert.ok(
        maximumLeft - minimumLeft <= 1,
        `Creating the first task shifted the browser webview: ${minimumLeft}..${maximumLeft}`
      )
      const hiddenFrames = elementMetricsSample.frames.filter(
        frame => frame.visibility !== 'visible'
      )
      assert.equal(
        hiddenFrames.length,
        0,
        `Creating the first task hid the browser webview for ${hiddenFrames.length} frames`
      )
      const activeSuffix = activeTemporaryLabel.slice(firstBrowserLabel.length)
      const activeMigratedLabel = migratedBaseLabel + activeSuffix
      await waitForBridgeActiveLabel(
        bridgeIdentity,
        firstBrowserLabel,
        activeMigratedLabel,
        uiTimeoutMs,
        'The browser bridge did not preserve the temporary task route after migration'
      )
      console.log('[browser-multi-tabs] bridge label migration completed')
      const migratedText = await waitForBridgeText(
        bridgeIdentity,
        activeMigratedLabel,
        activeExpectedText,
        uiTimeoutMs,
        'The browser tool lost the loaded page after its temporary label migrated'
      )
      console.log('[browser-multi-tabs] migrated active page inspected')
      assert.ok(migratedText.inspectText.includes(activeExpectedText))
      const activeBeforeReload = await callBridge(
        bridgeIdentity,
        { action: 'pageState' },
        activeMigratedLabel
      )
      assert.equal(activeBeforeReload.navigationError, null)
      assert.equal(activeBeforeReload.url, activeTemporaryPageState.url)
      await callBridge(bridgeIdentity, { action: 'reload' }, activeMigratedLabel)
      await waitForBridgeText(
        bridgeIdentity,
        activeMigratedLabel,
        activeExpectedText,
        uiTimeoutMs,
        'Reloading the migrated browser page left it blank'
      )
      const activeAfterReload = await callBridge(
        bridgeIdentity,
        { action: 'pageState' },
        activeMigratedLabel
      )
      assert.equal(activeAfterReload.navigationError, null)
      assert.equal(activeAfterReload.url, activeTemporaryPageState.url)
      console.log('[browser-multi-tabs] migrated page reloaded')
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('workspace-browser-navigation-error'),
        'The active migrated browser page showed an error after reload',
        uiTimeoutMs,
        ACTIVE_BROWSER_PANEL_SELECTOR
      )
      await captureMigrationScreenshot(captureScreenshot, control, resultDir)
      console.log('[browser-multi-tabs] migration screenshot captured')
      const appLog = await readFile(join(resultDir, 'app.log'), 'utf8')
      const attachmentRequestCountAfterTask = (
        appLog.match(/\[embedded-browser\] webview attachment requested/g) ?? []
      ).length
      assert.equal(
        attachmentRequestCountAfterTask,
        attachmentRequestCountBeforeTask,
        'Creating the first task attached a second blank webview instead of transferring the loaded one'
      )
    },
  }
}
