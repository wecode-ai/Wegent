import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPTS = {
  first: 'QUEUE_1_RUNNING_WEWORK_DESKTOP_E2E',
  second: 'QUEUE_2_WAITING_WEWORK_DESKTOP_E2E',
  third: 'QUEUE_3_WAITING_WEWORK_DESKTOP_E2E',
}

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function assistantMessage(id, text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `${id}-message`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
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

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const next = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    if (next) return next
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for a newly queued runtime task row')
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function sendNewTask(control, knownRows, prompt, timeoutMs, executionMode = 'local_path') {
  await control.command(
    'click',
    executionMode === 'git_worktree'
      ? '[data-testid="project-new-conversation-button"]'
      : '[data-testid="new-chat-button"]'
  )
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
  if (executionMode === 'git_worktree') {
    await control.command('waitFor', '[data-testid="execution-mode-button"]', { timeoutMs })
    await control.command('click', '[data-testid="execution-mode-button"]')
    await control.command('click', '[data-testid="execution-mode-git-worktree-button"]')
  }
  await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
  await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
  const rowTestId = await waitForNewTaskRow(control, knownRows, timeoutMs)
  knownRows.add(rowTestId)
  return {
    rowTestId,
    taskId: rowTestId.replace('runtime-local-task-row-', ''),
  }
}

async function waitForRequestCount(requests, count, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (requests.length >= count) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${count} runtime queue model requests`)
}

async function assertQueuePosition(control, selector, expected, visible, message) {
  const text = await control.command('getText', selector, { visible })
  const positions = text.split('\n').filter(Boolean)
  assert.ok(positions.length > 0, message ?? `No queue position found for ${selector}`)
  assert.ok(
    positions.includes(expected),
    message ?? `Expected a queue position of ${expected}, received ${text}`
  )
}

async function prepareScreenshot(control, hoverSelector = '[data-testid="new-chat-button"]') {
  await control.command('press', 'body', { key: 'Escape' })
  if (hoverSelector) {
    await control.command('hover', hoverSelector)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}

async function ensureRuntimeProjectExpanded(control, timeoutMs) {
  let sidebarSelector = `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar"]`
  const visibleSidebarCount = Number(
    await control.command('getElementCount', sidebarSelector, { visible: true })
  )
  let requireVisible = visibleSidebarCount > 0
  if (visibleSidebarCount === 0) {
    const hoverEdgeSelector = `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar-hover-edge"]`
    const hoverEdgeCount = Number(await control.command('getElementCount', hoverEdgeSelector))
    if (hoverEdgeCount > 0) {
      await control.command('hover', hoverEdgeSelector)
      sidebarSelector = `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar-preview-panel"]`
      requireVisible = true
      await control.command('waitFor', sidebarSelector, {
        timeoutMs,
        visible: true,
      })
    }
  }
  const visibleProjectsToggleSelector = `${sidebarSelector} [data-testid="projects-section-toggle"]`
  const projectButtonSelector = `${sidebarSelector} [data-testid="project-item-button"]`
  await control.command('waitFor', visibleProjectsToggleSelector, {
    timeoutMs,
    visible: requireVisible,
  })
  await control.command('scrollIntoView', visibleProjectsToggleSelector)
  const projectsSectionExpanded = await control.command(
    'getAttribute',
    visibleProjectsToggleSelector,
    {
      value: 'aria-expanded',
      visible: requireVisible,
    }
  )
  if (projectsSectionExpanded !== 'true') {
    await control.command('click', visibleProjectsToggleSelector, { visible: requireVisible })
  }
  await control.command('waitFor', projectButtonSelector, {
    timeoutMs,
    visible: requireVisible,
  })
  await control.command('scrollIntoView', projectButtonSelector)
  const projectExpanded = await control.command('getAttribute', projectButtonSelector, {
    value: 'aria-expanded',
    visible: requireVisible,
  })
  if (projectExpanded !== 'true') {
    await control.command('click', projectButtonSelector, { visible: requireVisible })
  }
  await control.command('waitFor', `${projectButtonSelector}[aria-expanded="true"]`, {
    timeoutMs,
    visible: requireVisible,
  })
  await new Promise(resolve => setTimeout(resolve, 350))
  return { requireVisible, sidebarSelector }
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let active = false
  const requests = []
  const releases = new Map()

  const releaseFor = prompt =>
    new Promise(resolve => {
      releases.set(prompt, resolve)
    })

  const releasePromises = new Map(
    Object.values(PROMPTS).map(prompt => [prompt, releaseFor(prompt)])
  )

  return {
    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const requestText = JSON.stringify(body)
      const prompt = Object.values(PROMPTS).find(candidate => requestText.includes(candidate))
      if (!prompt) {
        const responseId = `wework-runtime-queue-auxiliary-${Date.now()}`
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse([responseCreated(responseId), responseCompleted(responseId)]))
        return true
      }

      requests.push(prompt)
      const responseId = `wework-runtime-queue-${requests.length}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(sse([responseCreated(responseId)]))
      await releasePromises.get(prompt)
      response.end(
        sse([assistantMessage(responseId, `${prompt}_COMPLETE`), responseCompleted(responseId)])
      )
      return true
    },

    async verify(control) {
      active = true
      await control.command('waitFor', '[data-testid="settings-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      const shellSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      if (shellSnapshot.testIds.includes('desktop-sidebar-hover-edge')) {
        await control.command('toggleSidebar', 'body')
        await control.command('waitFor', '[data-testid="desktop-sidebar"]', {
          timeoutMs: uiTimeoutMs,
        })
      }
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('waitFor', '[data-testid="general-max-concurrent-tasks-select"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('select', '[data-testid="general-max-concurrent-tasks-select"]', {
        value: '1',
      })
      assert.equal(
        await control.command('getValue', '[data-testid="general-max-concurrent-tasks-select"]'),
        '1',
        'The runtime concurrency setting did not update to one'
      )
      await prepareScreenshot(control, null)
      await captureScreenshot(control, 'runtime-queue-01-limit-one.png', 'body')
      await control.command('click', '[data-testid="settings-back-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })

      const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      const knownRows = new Set(
        initialSnapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
      )
      const first = await sendNewTask(control, knownRows, PROMPTS.first, uiTimeoutMs)
      await waitForRequestCount(requests, 1, uiTimeoutMs)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar"] [data-testid="runtime-local-task-running-${first.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )

      const second = await sendNewTask(
        control,
        knownRows,
        PROMPTS.second,
        uiTimeoutMs,
        'git_worktree'
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar"] [data-testid="runtime-local-task-queued-${second.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const { requireVisible: sidebarVisible, sidebarSelector } =
        await ensureRuntimeProjectExpanded(control, uiTimeoutMs)
      await control.command(
        'scrollIntoView',
        `${sidebarSelector} [data-testid="runtime-local-task-queued-${second.taskId}"]`
      )
      await control.command(
        'waitFor',
        `${sidebarSelector} [data-testid="runtime-local-task-queued-${second.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: sidebarVisible,
        }
      )
      const queuedWorktreeSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      assert.equal(
        queuedWorktreeSnapshot.workbench?.currentRuntimeTask?.taskId,
        second.taskId,
        'The queued worktree task was not the active conversation'
      )
      const queuedWorktreePath = queuedWorktreeSnapshot.workbench?.currentRuntimeTask?.workspacePath
      assert.ok(queuedWorktreePath, 'The queued worktree task did not expose its planned path')
      assert.equal(
        await pathExists(queuedWorktreePath),
        false,
        'The queued task created its worktree before a concurrency slot was available'
      )
      const third = await sendNewTask(control, knownRows, PROMPTS.third, uiTimeoutMs)
      await control.command(
        'waitFor',
        `${sidebarSelector} [data-testid="runtime-local-task-queued-${third.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: sidebarVisible,
        }
      )
      assert.deepEqual(
        requests,
        [PROMPTS.first],
        'Queued tasks reached the model before a slot opened'
      )
      await assertQueuePosition(
        control,
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${second.taskId}"]`,
        '1',
        sidebarVisible
      )
      await assertQueuePosition(
        control,
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${third.taskId}"]`,
        '2',
        sidebarVisible
      )
      await prepareScreenshot(control)
      await assertQueuePosition(
        control,
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${second.taskId}"]`,
        '1',
        sidebarVisible,
        'The first queue position was lost after work-list refreshes settled'
      )
      await assertQueuePosition(
        control,
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${third.taskId}"]`,
        '2',
        sidebarVisible,
        'The second queue position was lost after work-list refreshes settled'
      )
      await captureScreenshot(control, 'runtime-queue-02-two-tasks-queued.png', 'body')

      await control.command('hover', `${sidebarSelector} [data-testid="${third.rowTestId}"]`)
      await control.command(
        'click',
        `${sidebarSelector} [data-testid="runtime-local-task-queue-up-${third.taskId}"]`,
        { visible: sidebarVisible }
      )
      await control.command(
        'waitFor',
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${third.taskId}"]`,
        {
          text: '1',
          timeoutMs: uiTimeoutMs,
          visible: sidebarVisible,
        }
      )
      await assertQueuePosition(
        control,
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${second.taskId}"]`,
        '2',
        sidebarVisible
      )
      await prepareScreenshot(control)
      await assertQueuePosition(
        control,
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${third.taskId}"]`,
        '1',
        sidebarVisible,
        'The reordered first position was lost after work-list refreshes settled'
      )
      await assertQueuePosition(
        control,
        `${sidebarSelector} [data-testid="runtime-local-task-queue-position-${second.taskId}"]`,
        '2',
        sidebarVisible,
        'The reordered second position was lost after work-list refreshes settled'
      )
      await captureScreenshot(control, 'runtime-queue-03-reordered.png', 'body')

      await control.command('hover', `${sidebarSelector} [data-testid="${third.rowTestId}"]`)
      await control.command(
        'click',
        `${sidebarSelector} [data-testid="runtime-local-task-force-start-${third.taskId}"]`,
        { visible: sidebarVisible }
      )
      await waitForRequestCount(requests, 2, uiTimeoutMs)
      assert.deepEqual(
        requests,
        [PROMPTS.first, PROMPTS.third],
        'Force start did not bypass the concurrency limit for the selected queued task'
      )
      await control.command(
        'waitFor',
        `${sidebarSelector} [data-testid="runtime-local-task-running-${third.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-04-force-started.png', 'body')

      releases.get(PROMPTS.first)?.()
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(
        requests.length,
        2,
        'Completing one overcommitted task incorrectly released another queued task'
      )
      releases.get(PROMPTS.third)?.()
      await waitForRequestCount(requests, 3, uiTimeoutMs)
      assert.deepEqual(
        requests,
        [PROMPTS.first, PROMPTS.third, PROMPTS.second],
        'The reordered queue did not determine the next execution order'
      )
      assert.equal(
        await pathExists(queuedWorktreePath),
        true,
        'The queued worktree was not created after the task acquired a concurrency slot'
      )
      releases.get(PROMPTS.second)?.()
      await control.command('click', `${sidebarSelector} [data-testid="${second.rowTestId}"]`)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: `${PROMPTS.second}_COMPLETE`,
          timeoutMs: uiTimeoutMs,
        }
      )
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-05-drained-in-order.png', 'body')
      active = false
    },

    diagnostics() {
      return { active, requests }
    },
  }
}
