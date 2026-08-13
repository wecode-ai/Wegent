import assert from 'node:assert/strict'

const ACTIVE_SURFACE = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER = '[data-testid="desktop-empty-composer-frame"] [data-testid="chat-message-input"]'
const FIRST_PROMPT = 'SPLIT LEFT TASK'
const SECOND_PROMPT = 'SPLIT RIGHT TASK'
const PANE_SELECTOR = '[data-testid^="workbench-pane-"][data-focused]'

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function assistantMessage(text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `wework-split-message-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function waitForProjectWorkButton(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (
      Number(await control.command('getElementCount', '[data-testid="project-work-button"]')) > 0
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The split-workbench project selector did not become available')
}

async function waitForFolderPath(control, workspacePath, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (
      (await control.command('getValue', '[data-testid="device-folder-path-input"]')) ===
      workspacePath
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The split-workbench folder picker did not retain the workspace path')
}

async function createLocalProject(control, workspacePath, timeoutMs) {
  await waitForProjectWorkButton(control, timeoutMs)
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPath(control, workspacePath, timeoutMs)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'split-workbench',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'split-workbench',
    timeoutMs,
  })
}

async function waitForNewTaskRow(control, knownRows, expectedText, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    for (const testId of candidates) {
      if ((await control.command('getText', `[data-testid="${testId}"]`)).includes(expectedText)) {
        return testId
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The split-workbench task row did not appear for ${expectedText}`)
}

async function waitForElementCount(control, selector, expectedCount, timeoutMs) {
  const startedAt = Date.now()
  let stableMatches = 0
  while (Date.now() - startedAt < timeoutMs) {
    const count = Number(await control.command('getElementCount', selector))
    stableMatches = count === expectedCount ? stableMatches + 1 : 0
    if (stableMatches >= 3) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Expected ${expectedCount} elements for ${selector}`)
}

async function createTask(control, prompt, timeoutMs) {
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  const knownRows = new Set(
    snapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  )
  await control.command('fill', COMPOSER, { value: prompt })
  await control.command('press', COMPOSER, { key: 'Enter' })
  await control.command('waitFor', `${ACTIVE_SURFACE} [data-testid="message-assistant"]`, {
    text: `${prompt}_COMPLETE`,
    timeoutMs,
  })
  return waitForNewTaskRow(control, knownRows, prompt, timeoutMs)
}

async function expandProject(control, timeoutMs) {
  const selector = `${ACTIVE_SURFACE} [data-testid="project-item-button"]`
  if ((await control.command('getAttribute', selector, { value: 'aria-expanded' })) !== 'true') {
    await control.command('click', selector)
  }
  await control.command('waitFor', `${selector}[aria-expanded="true"]`, {
    stableMs: 300,
    timeoutMs,
  })
}

async function paneSelectorForTitle(control, title) {
  const testId = await control.command('getAttribute', PANE_SELECTOR, {
    text: title,
    value: 'data-testid',
  })
  assert.ok(testId, `Unable to resolve the task pane for ${title}`)
  return `[data-testid="${testId}"]`
}

async function assertPaneConversation(control, paneSelector, expectedText) {
  await control.command('waitFor', `${paneSelector} [data-testid="message-assistant"]`, {
    text: expectedText,
    visible: true,
    stableMs: 300,
  })
  const [metrics] = JSON.parse(await control.command('getElementMetrics', paneSelector))
  assert.ok(metrics.width > 0 && metrics.height > 0, `${expectedText} pane has no visible area`)
}

async function assertIndependentTitlebar(control, paneSelector, title) {
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${paneSelector} [data-testid^="workbench-pane-header-actions-"]`
      )
    ),
    1,
    `${title} does not own a titlebar action area`
  )
  for (const testId of [
    'open-code-server-titlebar-button',
    'environment-info-button',
    'toggle-bottom-workspace-panel-button',
    'toggle-right-workspace-panel-button',
  ]) {
    assert.equal(
      Number(await control.command('getElementCount', `${paneSelector} [data-testid="${testId}"]`)),
      1,
      `${title} does not own ${testId}`
    )
  }
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/auth/wework/config') {
        json(response, 200, {
          web_url: `${url.protocol}//${url.host}`,
          socket_url: `${url.protocol}//${url.host}`,
        })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/users/me') {
        json(response, 401, { detail: 'Desktop split E2E runs without a cloud session' })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/teams') {
        json(response, 200, { items: [], total: 0 })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/devices') {
        json(response, 200, { items: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/models/unified') {
        json(response, 200, { data: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/quota/claude/quota') {
        json(response, 200, {})
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/runtime-work/im-notifications') {
        json(response, 200, {
          global: { enabled: false, sessionKey: null, session: null },
          runtimeTaskSubscriptions: [],
        })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/runtime-tasks/cloud-context') {
        json(response, 200, null)
        return true
      }
      if (request.method === 'PUT' && url.pathname === '/api/users/me') {
        const body = await readJson(request)
        json(response, 200, body)
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/apps/installed') {
        json(response, 200, { apps: [] })
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/connector-runtime/token') {
        json(response, 200, {
          access_token: 'desktop-e2e-connector-token',
          token_type: 'bearer',
          expires_in: 3_600,
        })
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/v1/loop-item-executions/claim-my-next'
      ) {
        json(response, 200, null)
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [] })
        return true
      }
      if (
        request.method === 'PUT' &&
        url.pathname === '/api/runtime-work/im-notifications/presence'
      ) {
        const body = await readJson(request)
        json(response, 200, { away: Boolean(body.away), ttlSeconds: 60 })
        return true
      }
      if (
        active &&
        request.method === 'POST' &&
        ['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        const body = await readJson(request)
        const input = JSON.stringify(body.input ?? body.messages ?? [])
        const prompt = input.includes(SECOND_PROMPT)
          ? SECOND_PROMPT
          : input.includes(FIRST_PROMPT)
            ? FIRST_PROMPT
            : null
        if (!prompt) return false
        const responseId = `wework-split-${Date.now()}`
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(`${prompt}_COMPLETE`),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      return false
    },

    async verify(control) {
      active = true
      const taskTimeoutMs = Math.max(uiTimeoutMs, 30_000)
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await control.command('waitFor', COMPOSER, { timeoutMs: uiTimeoutMs })
      const firstTaskRow = await createTask(control, FIRST_PROMPT, taskTimeoutMs)

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER, { stableMs: 500, timeoutMs: uiTimeoutMs })
      const secondTaskRow = await createTask(control, SECOND_PROMPT, taskTimeoutMs)
      const firstTaskId = firstTaskRow.replace('runtime-local-task-row-', '')
      const secondTaskId = secondTaskRow.replace('runtime-local-task-row-', '')

      await expandProject(control, uiTimeoutMs)
      const sidebar = `${ACTIVE_SURFACE} [data-testid="desktop-sidebar"]`
      const firstRow = `${sidebar} [data-testid="${firstTaskRow}"]`
      const secondRow = `${sidebar} [data-testid="${secondTaskRow}"]`
      await control.command('waitFor', firstRow, {
        text: FIRST_PROMPT,
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', secondRow, {
        text: SECOND_PROMPT,
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(
        Number(await control.command('getElementCount', PANE_SELECTOR)),
        1,
        'Single-task mode must render one pane'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="workbench-main-header"]')),
        1,
        'Single-task mode must keep the shared main header'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid^="workbench-pane-title-"]')),
        0,
        'Single-task mode must not duplicate task title chrome'
      )
      await assertPaneConversation(control, PANE_SELECTOR, `${SECOND_PROMPT}_COMPLETE`)
      await captureScreenshot(control, '01-split-single-task.png', 'body')

      await control.command(
        'dragStart',
        `${sidebar} [data-testid="runtime-local-task-drag-activator-${firstTaskId}"]`,
        { target: PANE_SELECTOR, timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', '[data-testid^="workbench-pane-drop-targets-"]', {
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      const centerTarget =
        '[data-testid^="workbench-pane-drop-targets-"] [data-workbench-pane-drop-position="center"]'
      const rightTarget =
        '[data-testid^="workbench-pane-drop-targets-"] [data-workbench-pane-drop-position="right"]'
      const [centerMetrics] = JSON.parse(await control.command('getElementMetrics', centerTarget))
      const [rightMetrics] = JSON.parse(await control.command('getElementMetrics', rightTarget))
      assert.ok(
        centerMetrics.width > rightMetrics.width * 3 &&
          centerMetrics.width * centerMetrics.height > rightMetrics.width * rightMetrics.height * 3,
        `The current-window drop target is not dominant: ${JSON.stringify({
          centerMetrics,
          rightMetrics,
        })}`
      )
      await captureScreenshot(control, '02-split-drag-targets.png', 'body')

      const splitStartedAt = Date.now()
      await control.command('dragEnd', 'body', {
        target: rightTarget,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[role="separator"][data-separator]', {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      const splitDurationMs = Date.now() - splitStartedAt
      assert.ok(
        splitDurationMs < 3_000,
        `Sidebar drag took too long to create a split: ${splitDurationMs}ms`
      )
      console.log(`[split-workbench] sidebar drag created the split in ${splitDurationMs}ms`)
      assert.equal(
        Number(await control.command('getElementCount', PANE_SELECTOR)),
        2,
        'Sidebar edge drop must create exactly two panes'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="workbench-main-header"]')),
        0,
        'Split mode must remove the shared task toolbar'
      )
      const firstPane = await paneSelectorForTitle(control, FIRST_PROMPT)
      const secondPane = await paneSelectorForTitle(control, SECOND_PROMPT)
      await assertPaneConversation(control, firstPane, `${FIRST_PROMPT}_COMPLETE`)
      await assertPaneConversation(control, secondPane, `${SECOND_PROMPT}_COMPLETE`)
      await assertIndependentTitlebar(control, firstPane, FIRST_PROMPT)
      await assertIndependentTitlebar(control, secondPane, SECOND_PROMPT)
      await captureScreenshot(control, '03-split-two-independent-panes.png', 'body')

      const firstFocus = `${firstPane} [data-testid^="workbench-focus-pane-"]`
      await control.command('click', firstFocus)
      await control.command(
        'waitFor',
        '[data-testid="workbench-split-layout"][data-focused-pane]',
        { stableMs: 300, timeoutMs: uiTimeoutMs }
      )
      assert.equal(
        Number(await control.command('getElementCount', PANE_SELECTOR)),
        1,
        'Focused task view must show one pane'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[role="separator"][data-separator]')),
        0,
        'Focused task view must hide split separators'
      )
      await assertPaneConversation(control, firstPane, `${FIRST_PROMPT}_COMPLETE`)
      await captureScreenshot(control, '04-split-focused-task.png', 'body')

      await control.command('click', firstFocus)
      await control.command('waitFor', '[role="separator"][data-separator]', {
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', PANE_SELECTOR)),
        2,
        'Returning from focus view must restore both panes'
      )
      await captureScreenshot(control, '05-split-restored.png', 'body')

      await control.command('click', `${firstPane} [data-testid="environment-info-button"]`)
      await control.command('waitFor', '[data-testid="environment-info-popover"]', {
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            [
              `${firstPane} [data-testid="environment-info-button"][aria-expanded="true"]`,
              `${secondPane} [data-testid="environment-info-button"][aria-expanded="false"]`,
            ].join(', ')
          )
        ),
        2,
        'Environment state leaked into the other pane'
      )
      await captureScreenshot(control, '06-split-local-environment.png', 'body')
      await control.command('click', `${firstPane} [data-testid="environment-info-button"]`)
      await waitForElementCount(control, '[data-testid="environment-info-popover"]', 0, uiTimeoutMs)

      await control.command(
        'click',
        `${firstPane} [data-testid="toggle-bottom-workspace-panel-button"]`
      )
      await control.command(
        'waitFor',
        `${firstPane} [data-testid="bottom-workspace-panel"][aria-hidden="false"]`,
        { visible: true, stableMs: 300, timeoutMs: uiTimeoutMs }
      )
      const [bottomPanelMetrics] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${firstPane} [data-testid="bottom-workspace-panel"][aria-hidden="false"]`
        )
      )
      const [firstPaneMetrics] = JSON.parse(await control.command('getElementMetrics', firstPane))
      assert.ok(
        bottomPanelMetrics.height >= 220 &&
          bottomPanelMetrics.top >= firstPaneMetrics.top &&
          bottomPanelMetrics.bottom <= firstPaneMetrics.bottom,
        `Bottom workspace panel is outside its pane: ${JSON.stringify({
          bottomPanelMetrics,
          paneMetrics: firstPaneMetrics,
        })}`
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${secondPane} [data-testid="bottom-workspace-panel"][aria-hidden="false"]`
          )
        ),
        0,
        'Bottom panel state leaked into the other pane'
      )
      await captureScreenshot(control, '07-split-local-bottom-panel.png', 'body')
      await control.command(
        'click',
        `${firstPane} [data-testid="toggle-bottom-workspace-panel-button"]`
      )
      await control.command(
        'waitFor',
        `${firstPane} [data-testid="bottom-workspace-panel"][aria-hidden="true"]`,
        { stableMs: 300, timeoutMs: uiTimeoutMs }
      )

      await control.command(
        'click',
        `${secondPane} [data-testid="toggle-right-workspace-panel-button"]`
      )
      await control.command(
        'waitFor',
        `${secondPane} [data-testid="right-workspace-panel-shell"][aria-hidden="false"]`,
        { visible: true, stableMs: 300, timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', `${secondPane} [data-testid="right-workspace-launcher"]`, {
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `${secondPane} [data-testid="right-workspace-browser-option"]`,
        { visible: true, stableMs: 300, timeoutMs: uiTimeoutMs }
      )
      const [rightPanelMetrics] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${secondPane} [data-testid="right-workspace-panel-shell"]`
        )
      )
      const [rightLauncherMetrics] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${secondPane} [data-testid="right-workspace-launcher"]`
        )
      )
      const [rightBrowserOptionMetrics] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${secondPane} [data-testid="right-workspace-browser-option"]`
        )
      )
      const [secondPaneMetrics] = JSON.parse(await control.command('getElementMetrics', secondPane))
      assert.ok(
        rightPanelMetrics.width >= 260 &&
          rightLauncherMetrics.width >= 180 &&
          rightBrowserOptionMetrics.width >= 180 &&
          rightPanelMetrics.left >= secondPaneMetrics.left &&
          rightPanelMetrics.right <= secondPaneMetrics.right,
        `Right workspace panel is not visibly contained by its pane: ${JSON.stringify({
          browserOptionMetrics: rightBrowserOptionMetrics,
          launcherMetrics: rightLauncherMetrics,
          paneMetrics: secondPaneMetrics,
          panelMetrics: rightPanelMetrics,
        })}`
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${firstPane} [data-testid="right-workspace-panel-shell"][aria-hidden="false"]`
          )
        ),
        0,
        'Right panel state leaked into the other pane'
      )
      await captureScreenshot(control, '08-split-local-right-panel.png', 'body')
      await control.command(
        'click',
        `${secondPane} [data-testid="toggle-right-workspace-panel-button"]`
      )
      await control.command(
        'waitFor',
        `${secondPane} [data-testid="right-workspace-panel-shell"][aria-hidden="true"]`,
        { stableMs: 300, timeoutMs: uiTimeoutMs }
      )

      const [beforeResize] = JSON.parse(await control.command('getElementMetrics', secondPane))
      await control.command('drag', '[role="separator"][data-separator]', {
        target: firstPane,
        timeoutMs: uiTimeoutMs,
      })
      const [afterResize] = JSON.parse(await control.command('getElementMetrics', secondPane))
      assert.ok(
        Math.abs(afterResize.width - beforeResize.width) > 40,
        'Dragging the separator did not visibly resize the split'
      )
      await captureScreenshot(control, '09-split-resized.png', 'body')

      const readyCountBeforeReload = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCountBeforeReload)
      await control.command('waitFor', PANE_SELECTOR, { timeoutMs: uiTimeoutMs })
      assert.equal(
        Number(await control.command('getElementCount', PANE_SELECTOR)),
        2,
        'Reloading did not restore both panes'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid^="workbench-pane-title-"]')),
        2,
        'Reloading restored hidden task tabs or lost a pane title'
      )
      const restoredFirstPane = await paneSelectorForTitle(control, FIRST_PROMPT)
      const restoredSecondPane = await paneSelectorForTitle(control, SECOND_PROMPT)
      await assertPaneConversation(control, restoredFirstPane, `${FIRST_PROMPT}_COMPLETE`)
      await assertPaneConversation(control, restoredSecondPane, `${SECOND_PROMPT}_COMPLETE`)
      await captureScreenshot(control, '10-split-restored-after-reload.png', 'body')

      await control.command('click', `${restoredFirstPane} [data-testid^="workbench-close-pane-"]`)
      await control.command('waitFor', PANE_SELECTOR, {
        text: SECOND_PROMPT,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', PANE_SELECTOR)),
        1,
        'Closing a pane did not collapse the split'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="workbench-main-header"]')),
        1,
        'Returning to single-task mode did not restore the shared header'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid^="workbench-pane-title-"]')),
        0,
        'Returning to single-task mode retained split title chrome'
      )
      await captureScreenshot(control, '11-split-return-single.png', 'body')

      assert.ok(firstTaskId && secondTaskId)
    },
  }
}
