import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'

import { ensureProjectExpandedInActiveSidebar } from '../modules/project-sidebar.mjs'
import { createSingleRootLocalProject } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPTS = {
  first: 'QUEUE_1_RUNNING_WEWORK_DESKTOP_E2E',
  second: 'QUEUE_2_WAITING_WEWORK_DESKTOP_E2E',
  third: 'QUEUE_3_WAITING_WEWORK_DESKTOP_E2E',
  fourth: 'QUEUE_4_RUNNING_BEFORE_LIMIT_INCREASE_WEWORK_DESKTOP_E2E',
  fifth: 'QUEUE_5_STARTS_AFTER_LIMIT_INCREASE_WEWORK_DESKTOP_E2E',
  followUpCancel: 'QUEUE_FOLLOW_UP_CANCEL_WEWORK_DESKTOP_E2E',
  followUpForce: 'QUEUE_FOLLOW_UP_FORCE_WEWORK_DESKTOP_E2E',
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
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function sendNewTask(
  control,
  newConversationSelector,
  knownRows,
  prompt,
  timeoutMs,
  executionMode = 'local_path'
) {
  await control.command('clickWhenEnabled', newConversationSelector, {
    timeoutMs,
  })
  await control.command('waitFor', COMPOSER_SELECTOR)
  await control.command('waitFor', '[data-testid="execution-mode-button"]')
  await control.command('click', '[data-testid="execution-mode-button"]')
  const executionModeSelector =
    executionMode === 'git_worktree'
      ? '[data-testid="execution-mode-git-worktree-button"]'
      : '[data-testid="execution-mode-current-workspace-button"]'
  await control.command('clickWhenEnabled', executionModeSelector)
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

async function waitForSnapshot(control, predicate, message, timeoutMs) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}; last testIds=${JSON.stringify(lastSnapshot?.testIds ?? [])}`)
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

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
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
      const prompt = Object.values(PROMPTS)
        .map(candidate => ({ candidate, index: requestText.lastIndexOf(candidate) }))
        .filter(match => match.index >= 0)
        .sort((left, right) => right.index - left.index)[0]?.candidate
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
      await createSingleRootLocalProject(control, workspacePath, 'runtime-task-queue')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const createdProjectSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const createdProjectId = createdProjectSnapshot.workbench?.currentProject?.id
      assert.ok(createdProjectId, 'The created queue project did not become the active project')
      const newConversationSelector =
        `[data-testid="project-row-${createdProjectId}"] ` +
        '[data-testid="project-new-conversation-button"]'
      await control.command('waitFor', newConversationSelector, {
        timeoutMs: uiTimeoutMs,
      })

      const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      const knownRows = new Set(
        initialSnapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
      )
      const first = await sendNewTask(
        control,
        newConversationSelector,
        knownRows,
        PROMPTS.first,
        uiTimeoutMs
      )
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
        newConversationSelector,
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
        await ensureProjectExpandedInActiveSidebar(control, { timeoutMs: uiTimeoutMs })
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
      const third = await sendNewTask(
        control,
        newConversationSelector,
        knownRows,
        PROMPTS.third,
        uiTimeoutMs
      )
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

      const fourth = await sendNewTask(
        control,
        newConversationSelector,
        knownRows,
        PROMPTS.fourth,
        uiTimeoutMs
      )
      await waitForRequestCount(requests, 4, uiTimeoutMs)
      await control.command(
        'waitFor',
        `${sidebarSelector} [data-testid="runtime-local-task-running-${fourth.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: sidebarVisible,
        }
      )
      await control.command('click', `${sidebarSelector} [data-testid="${second.rowTestId}"]`)
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-follow-up-00-capacity-full.png', 'body')
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPTS.followUpCancel })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
        text: PROMPTS.followUpCancel,
        timeoutMs: uiTimeoutMs,
      })
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-follow-up-01-queued.png', 'body')
      const queuedFollowUpMessages = await control.command(
        'getText',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
      )
      assert.equal(
        queuedFollowUpMessages.includes(PROMPTS.followUpCancel),
        false,
        'The queued follow-up was rendered as an already-sent conversation message'
      )
      await control.command('click', '[data-testid^="queue-cancel-button-"]')
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
        'Cancelling the native queued follow-up did not clear the composer queue',
        uiTimeoutMs
      )
      assert.equal(requests.length, 4, 'Cancelling the queued follow-up reached the model')
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-follow-up-02-cancelled.png', 'body')

      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPTS.followUpForce })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
        text: PROMPTS.followUpForce,
        timeoutMs: uiTimeoutMs,
      })
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-follow-up-03-ready-to-force.png', 'body')
      await control.command('click', '[data-testid^="queue-force-start-button-"]')
      await waitForRequestCount(requests, 5, uiTimeoutMs)
      assert.equal(
        requests[4],
        PROMPTS.followUpForce,
        'Forcing the queued follow-up did not bypass the concurrency limit'
      )
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
        'Force starting the native queued follow-up did not clear the composer queue',
        uiTimeoutMs
      )
      const startedFollowUpMessages = await control.command(
        'getText',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
      )
      assert.equal(
        startedFollowUpMessages.includes(PROMPTS.followUpForce),
        true,
        'The queued follow-up was not rendered after its turn started'
      )
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-follow-up-04-force-started.png', 'body')
      releases.get(PROMPTS.followUpForce)?.()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: `${PROMPTS.followUpForce}_COMPLETE`,
          timeoutMs: uiTimeoutMs,
        }
      )
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-follow-up-05-completed.png', 'body')

      const fifth = await sendNewTask(
        control,
        newConversationSelector,
        knownRows,
        PROMPTS.fifth,
        uiTimeoutMs
      )
      await control.command(
        'waitFor',
        `${sidebarSelector} [data-testid="runtime-local-task-queued-${fifth.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: sidebarVisible,
        }
      )
      assert.equal(requests.length, 5, 'The regression task did not wait at concurrency one')

      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('waitFor', '[data-testid="general-max-concurrent-tasks-select"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('select', '[data-testid="general-max-concurrent-tasks-select"]', {
        value: '2',
      })
      await waitForRequestCount(requests, 6, uiTimeoutMs)
      await control.command('click', '[data-testid="settings-back-button"]')
      const { requireVisible: refreshedSidebarVisible, sidebarSelector: refreshedSidebarSelector } =
        await ensureProjectExpandedInActiveSidebar(control, { timeoutMs: uiTimeoutMs })
      await control.command(
        'waitFor',
        `${refreshedSidebarSelector} [data-testid="runtime-local-task-running-${fifth.taskId}"]`,
        {
          timeoutMs: uiTimeoutMs,
          visible: refreshedSidebarVisible,
        }
      )
      await prepareScreenshot(control)
      await captureScreenshot(control, 'runtime-queue-06-limit-increase-drained.png', 'body')
      releases.get(PROMPTS.fourth)?.()
      releases.get(PROMPTS.fifth)?.()
      active = false
    },

    diagnostics() {
      return { active, requests }
    },
  }
}
