import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'

import { ensureProjectExpandedInActiveSidebar } from '../modules/project-sidebar.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

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
  backgroundFirst: 'QUEUE_BACKGROUND_FIRST_WEWORK_DESKTOP_E2E',
  backgroundSecond: 'QUEUE_BACKGROUND_SECOND_WEWORK_DESKTOP_E2E',
  backgroundThird: 'QUEUE_BACKGROUND_THIRD_WEWORK_DESKTOP_E2E',
  resumeInitial: 'QUEUE_RESUME_INITIAL_WEWORK_DESKTOP_E2E',
  resumeInput: 'QUEUE_RESUME_INPUT_WEWORK_DESKTOP_E2E',
  resumeFirst: 'QUEUE_RESUME_FIRST_WEWORK_DESKTOP_E2E',
  resumeSecond: 'QUEUE_RESUME_SECOND_WEWORK_DESKTOP_E2E',
  resumeThird: 'QUEUE_RESUME_THIRD_WEWORK_DESKTOP_E2E',
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
  await selectE2EModel(control, undefined, undefined, ACTIVE_WORKBENCH_SELECTOR)
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

async function waitForRequestCount(requests, count, timeoutMs, description = 'model requests') {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (requests.length >= count) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${count} runtime queue ${description}`)
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

async function enqueueFollowUps(control, prompts, timeoutMs) {
  for (const prompt of prompts) {
    await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="conversation-queue-panel"]`,
      { text: prompt, timeoutMs }
    )
  }
  const rowIds = await queueRowIds(control)
  assert.equal(rowIds.length, prompts.length, 'Not all follow-ups were retained in the queue')
  return rowIds
}

async function queueRowIds(control) {
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  return snapshot.testIds.filter(testId => testId.startsWith('conversation-queue-row-'))
}

async function assertRestoredFollowUps(control, prompts, timeoutMs) {
  const previewSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"]`
  for (const prompt of prompts) {
    await control.command('waitFor', previewSelector, { text: prompt, timeoutMs })
    const turnIndex = await control.command('getAttribute', previewSelector, {
      text: prompt,
      value: 'data-turn-index',
    })
    assert.match(turnIndex, /^\d+$/, `No navigation marker for the follow-up: ${prompt}`)
    await control.command(
      'click',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"][data-turn-index="${turnIndex}"]`
    )
    await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`, {
      text: prompt,
      stableMs: 500,
      timeoutMs,
    })
    const messages = await control.command(
      'getText',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
    )
    assert.equal(
      messages.split(prompt).length - 1,
      1,
      `The follow-up was missing or duplicated after task restoration: ${prompt}`
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      { text: `${prompt}_COMPLETE`, timeoutMs }
    )
  }
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  const requests = []
  const cancelledRequests = []
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
      let cancelled = false
      const recordCancellation = () => {
        if (cancelled || response.writableEnded) return
        cancelled = true
        cancelledRequests.push(prompt)
        releases.get(prompt)()
      }
      request.once('aborted', recordCancellation)
      response.once('close', recordCancellation)
      const responseId = `wework-runtime-queue-${requests.length}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(sse([responseCreated(responseId)]))
      try {
        await releasePromises.get(prompt)
        if (!cancelled && !request.aborted && !response.destroyed) {
          response.end(
            sse([assistantMessage(responseId, `${prompt}_COMPLETE`), responseCompleted(responseId)])
          )
        }
      } finally {
        request.off('aborted', recordCancellation)
        response.off('close', recordCancellation)
      }
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

      await control.command(
        'click',
        `${refreshedSidebarSelector} [data-testid="${fourth.rowTestId}"]`,
        { visible: refreshedSidebarVisible }
      )
      const backgroundTaskSnapshot = await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId === fourth.taskId,
        'The background queue source task did not become active',
        uiTimeoutMs
      )
      const backgroundTask = backgroundTaskSnapshot.workbench.currentRuntimeTask
      const backgroundPaneSelector = `[data-workbench-pane-host="runtime:${backgroundTask.deviceId}:${fourth.taskId}"]`
      await control.command('waitFor', backgroundPaneSelector, { timeoutMs: uiTimeoutMs })
      const backgroundPrompts = [
        PROMPTS.backgroundFirst,
        PROMPTS.backgroundSecond,
        PROMPTS.backgroundThird,
      ]
      await enqueueFollowUps(control, backgroundPrompts, uiTimeoutMs)
      const requestsBeforeBackgroundDrain = [...requests]
      assert.equal(
        requestsBeforeBackgroundDrain.length,
        6,
        'A queued follow-up reached the model while its source task was still running'
      )
      await captureScreenshot(control, 'runtime-queue-background-01-three-follow-ups.png', 'body')

      await control.command(
        'click',
        `${refreshedSidebarSelector} [data-testid="${fifth.rowTestId}"]`,
        { visible: refreshedSidebarVisible }
      )
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId === fifth.taskId,
        'The other task did not become active before draining the background queue',
        uiTimeoutMs
      )
      assert.equal(
        Number(await control.command('getElementCount', backgroundPaneSelector)),
        0,
        'The source conversation remained mounted after switching tasks'
      )
      const otherTaskSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        otherTaskSnapshot.testIds.includes('conversation-queue-panel'),
        false,
        'The background task queue leaked into the other conversation'
      )

      // Complete the source turn only after its conversation has unmounted.
      assert.deepEqual(
        requests,
        requestsBeforeBackgroundDrain,
        'The background queue dispatched before its source response was released'
      )
      releases.get(PROMPTS.fourth)?.()
      for (const [index, prompt] of backgroundPrompts.entries()) {
        await waitForRequestCount(
          requests,
          requestsBeforeBackgroundDrain.length + index + 1,
          uiTimeoutMs
        )
        assert.deepEqual(
          requests,
          [...requestsBeforeBackgroundDrain, ...backgroundPrompts.slice(0, index + 1)],
          'The unmounted task did not send queued messages exactly once in submission order'
        )
        releases.get(prompt)?.()
      }
      await waitForCompletedRuntimeTaskThread(control, fourth.taskId, uiTimeoutMs)
      const afterDrainSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      assert.equal(
        afterDrainSnapshot.workbench?.currentRuntimeTask?.taskId,
        fifth.taskId,
        'Draining the background queue changed the active conversation'
      )
      await captureScreenshot(control, 'runtime-queue-background-02-drained-while-away.png', 'body')

      await control.command(
        'click',
        `${refreshedSidebarSelector} [data-testid="${fourth.rowTestId}"]`,
        { visible: refreshedSidebarVisible }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: `${PROMPTS.backgroundThird}_COMPLETE`, stableMs: 500, timeoutMs: uiTimeoutMs }
      )
      const restoredSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        restoredSnapshot.testIds.includes('conversation-queue-panel'),
        false,
        'Returning to the completed background task restored an already-drained queue'
      )
      await assertRestoredFollowUps(control, backgroundPrompts, uiTimeoutMs)
      assert.deepEqual(
        requests,
        [...requestsBeforeBackgroundDrain, ...backgroundPrompts],
        'Returning to the source task sent a queued message again'
      )
      await captureScreenshot(
        control,
        'runtime-queue-background-03-restored-without-duplicates.png',
        'body'
      )

      const requestsBeforeResume = [...requests]
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPTS.resumeInitial })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await waitForRequestCount(requests, requestsBeforeResume.length + 1, uiTimeoutMs)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
        { timeoutMs: uiTimeoutMs }
      )
      const resumePrompts = [PROMPTS.resumeFirst, PROMPTS.resumeSecond, PROMPTS.resumeThird]
      const preservedRowIds = await enqueueFollowUps(control, resumePrompts, uiTimeoutMs)
      const requestsBeforeResumeInput = [...requestsBeforeResume, PROMPTS.resumeInitial]
      assert.deepEqual(
        requests,
        requestsBeforeResumeInput,
        'The follow-ups reached the model before the source turn was stopped'
      )
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
      )
      await waitForRequestCount(cancelledRequests, 1, uiTimeoutMs, 'cancelled model requests')
      assert.deepEqual(cancelledRequests, [PROMPTS.resumeInitial])
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="resume-queue-button"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await waitForCompletedRuntimeTaskThread(control, fourth.taskId, uiTimeoutMs)
      assert.deepEqual(await queueRowIds(control), preservedRowIds, 'Stopping lost queued messages')
      assert.deepEqual(requests, requestsBeforeResumeInput, 'Stopping dispatched a queued message')
      await captureScreenshot(control, 'runtime-queue-resume-01-paused.png', 'body')

      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPTS.resumeInput })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="paused-queue-send-dialog"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.deepEqual(requests, requestsBeforeResumeInput, 'Opening the resume dialog sent input')
      await control.command('click', '[data-testid="paused-queue-send-preserve-button"]')
      await waitForRequestCount(requests, requestsBeforeResumeInput.length + 1, uiTimeoutMs)
      const requestsDuringResumeInput = [...requestsBeforeResumeInput, PROMPTS.resumeInput]
      assert.deepEqual(
        requests,
        requestsDuringResumeInput,
        'The additional input did not start before the preserved queue'
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="resume-queue-button"]`,
        { timeoutMs: uiTimeoutMs }
      )
      assert.deepEqual(
        await queueRowIds(control),
        preservedRowIds,
        'Keeping the queue replaced or removed its original messages'
      )
      await control.command(
        'click',
        `${refreshedSidebarSelector} [data-testid="${fifth.rowTestId}"]`,
        { visible: refreshedSidebarVisible }
      )
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId === fifth.taskId,
        'The other task did not become active during the additional-input turn',
        uiTimeoutMs
      )
      assert.equal(
        Number(await control.command('getElementCount', backgroundPaneSelector)),
        0,
        'The paused queue source remained mounted after switching tasks'
      )
      assert.deepEqual(
        await queueRowIds(control),
        [],
        'The resumed queue leaked into the other task'
      )
      assert.deepEqual(
        requests,
        requestsDuringResumeInput,
        'The preserved queue ran while the additional-input turn was still held'
      )
      await captureScreenshot(control, 'runtime-queue-resume-02-input-held-while-away.png', 'body')
      assert.deepEqual(
        requests,
        requestsDuringResumeInput,
        'The preserved queue dispatched before the additional-input response was released'
      )

      // Keep the manual turn held until the source pane is gone, then release one queued turn at a time.
      releases.get(PROMPTS.resumeInput)()
      for (const [index, prompt] of resumePrompts.entries()) {
        await waitForRequestCount(
          requests,
          requestsDuringResumeInput.length + index + 1,
          uiTimeoutMs
        )
        assert.deepEqual(
          requests,
          [...requestsDuringResumeInput, ...resumePrompts.slice(0, index + 1)],
          'The preserved queue did not resume exactly once in order after the manual turn ended'
        )
        releases.get(prompt)()
      }
      await waitForCompletedRuntimeTaskThread(control, fourth.taskId, uiTimeoutMs)
      const resumedSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      assert.equal(
        resumedSnapshot.workbench?.currentRuntimeTask?.taskId,
        fifth.taskId,
        'Resuming the background queue changed the active task'
      )
      await captureScreenshot(control, 'runtime-queue-resume-03-drained-while-away.png', 'body')
      await control.command(
        'click',
        `${refreshedSidebarSelector} [data-testid="${fourth.rowTestId}"]`,
        { visible: refreshedSidebarVisible }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: `${PROMPTS.resumeThird}_COMPLETE`, stableMs: 500, timeoutMs: uiTimeoutMs }
      )
      const finalSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.equal(
        finalSnapshot.testIds.includes('conversation-queue-panel'),
        false,
        'Returning restored a queue that had already resumed and drained'
      )
      await assertRestoredFollowUps(control, [PROMPTS.resumeInput, ...resumePrompts], uiTimeoutMs)
      assert.deepEqual(
        requests,
        [...requestsDuringResumeInput, ...resumePrompts],
        'Returning after resume dispatched the additional input or a queued message again'
      )
      assert.deepEqual(cancelledRequests, [PROMPTS.resumeInitial])
      await captureScreenshot(
        control,
        'runtime-queue-resume-04-restored-without-duplicates.png',
        'body'
      )
      releases.get(PROMPTS.fifth)?.()
      await waitForCompletedRuntimeTaskThread(control, fifth.taskId, uiTimeoutMs)
      active = false
    },

    async cleanup() {
      active = false
      for (const release of releases.values()) release()
    },

    diagnostics() {
      return { active, requests, cancelledRequests }
    },
  }
}
