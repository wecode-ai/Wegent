import assert from 'node:assert/strict'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

const ACTIVE_WORKSPACE_TAB = '[data-workspace-tab-content][aria-hidden="false"]'
const ACTIVE_WORKBENCH =
  `${ACTIVE_WORKSPACE_TAB} ` +
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR =
  `${ACTIVE_WORKBENCH} ` + '[data-testid="chat-message-input"][contenteditable="true"]'
const TAB_STRIP = '[data-testid="workspace-tab-strip"]'
const TASKS = [
  {
    prompt: 'WEWORK_E2E_NOTIFICATION_TAB_FIRST',
    completion: 'WEWORK_E2E_NOTIFICATION_TAB_FIRST_COMPLETE',
  },
  {
    prompt: 'WEWORK_E2E_NOTIFICATION_TAB_SECOND',
    completion: 'WEWORK_E2E_NOTIFICATION_TAB_SECOND_COMPLETE',
  },
]

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function responseStartEvents(responseId) {
  const itemId = `${responseId}-message`
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  ]
}

function responseFinishEvents(responseId, itemId, text) {
  return [
    {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]
}

function workspaceTabTestIds(snapshot, kind) {
  return snapshot.testIds.filter(
    testId =>
      testId === `workspace-tab-fixed-${kind}` || testId.startsWith(`workspace-tab-${kind}-`)
  )
}

async function activeWorkspaceTabId(control) {
  return control.command('getAttribute', ACTIVE_WORKSPACE_TAB, {
    value: 'data-workspace-tab-content',
  })
}

async function workspaceSnapshot(control) {
  return JSON.parse(await control.command('snapshot', TAB_STRIP))
}

async function ensureBoardTab(control, uiTimeoutMs) {
  let snapshot = await workspaceSnapshot(control)
  let boardTabs = workspaceTabTestIds(snapshot, 'board')
  if (boardTabs.length === 0) {
    await control.command('click', '[data-testid="workspace-tab-add"]')
    await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-add-board"]')
    const deadline = Date.now() + uiTimeoutMs
    while (Date.now() < deadline && boardTabs.length === 0) {
      snapshot = await workspaceSnapshot(control)
      boardTabs = workspaceTabTestIds(snapshot, 'board')
      if (boardTabs.length === 0) await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  assert.equal(boardTabs.length, 1, 'The workbench did not expose exactly one board tab')
  return boardTabs[0].slice('workspace-tab-'.length)
}

async function waitForTaskRow(control, prompt, uiTimeoutMs) {
  const deadline = Date.now() + uiTimeoutMs
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKSPACE_TAB))
    for (const testId of snapshot.testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )) {
      const text = await control.command(
        'getText',
        `${ACTIVE_WORKSPACE_TAB} [data-testid="${testId}"]`
      )
      if (text.includes(prompt)) {
        return {
          rowTestId: testId,
          taskId: testId.slice('runtime-local-task-row-'.length),
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Timed out waiting for the runtime task containing "${prompt}"`)
}

async function sendTask(control, newConversationSelector, task, uiTimeoutMs) {
  await control.command('clickWhenEnabled', newConversationSelector, { timeoutMs: uiTimeoutMs })
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
  await control.command('fill', COMPOSER_SELECTOR, { value: task.prompt })
  await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
  return waitForTaskRow(control, task.prompt, uiTimeoutMs)
}

async function waitForUnreadCount(control, count, uiTimeoutMs) {
  const deadline = Date.now() + uiTimeoutMs
  let latest = null
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('wework-notifications-unread')) {
      latest = await control.command('getText', '[data-testid="wework-notifications-unread"]')
      if (latest === String(count)) return
    } else {
      latest = '0'
      if (count === 0) return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Expected ${count} unread notifications, received ${latest}`)
}

async function openTaskNotification(control, taskId, uiTimeoutMs) {
  await control.command('click', '[data-testid="wework-notifications-button"]')
  await control.command('waitFor', '[data-testid="wework-notifications-category-tasks"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="wework-notifications-category-tasks"]')
  const rowSelector = `[data-testid="wework-notification-task-${taskId}"]`
  await control.command('waitFor', rowSelector, { timeoutMs: uiTimeoutMs })
  await control.command('click', rowSelector)
  await control.command('waitFor', '[data-testid="wework-notifications-popover"]', {
    visible: false,
    timeoutMs: uiTimeoutMs,
  })
}

async function waitForCurrentRuntimeTask(control, taskId, completion, uiTimeoutMs) {
  const deadline = Date.now() + uiTimeoutMs
  let latestTaskId = null
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    latestTaskId = snapshot.workbench?.currentRuntimeTask?.taskId ?? null
    if (latestTaskId === taskId) {
      await control.command('waitFor', `${ACTIVE_WORKBENCH} [data-testid="message-assistant"]`, {
        text: completion,
        timeoutMs: uiTimeoutMs,
      })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(
    `Expected notification navigation to open runtime task ${taskId}, opened ${latestTaskId}`
  )
}

export function createDesktopScenario({ uiTimeoutMs, workspacePath }) {
  let requestCount = 0
  const streams = new Map()

  const waitForStream = async prompt => {
    const deadline = Date.now() + uiTimeoutMs
    while (Date.now() < deadline) {
      const stream = streams.get(prompt)
      if (stream) return stream
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`The runtime never requested the model for "${prompt}"`)
  }

  const finishTask = (task, stream) => {
    for (const event of responseFinishEvents(stream.responseId, stream.itemId, task.completion)) {
      stream.response.write(sse(event))
    }
    stream.response.end()
    streams.delete(task.prompt)
  }

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const task = TASKS.find(candidate => payload.includes(candidate.prompt))
      if (!task) return false
      const responseId = `wework-notification-tab-${++requestCount}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      const itemId = `${responseId}-message`
      for (const event of responseStartEvents(responseId)) response.write(sse(event))
      streams.set(task.prompt, { response, responseId, itemId })
      return true
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await createSingleRootLocalProject(control, workspacePath, 'notification-task-tab')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control)
      const projectSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const projectId = projectSnapshot.workbench?.currentProject?.id
      assert.ok(projectId, 'The notification navigation project did not become active')
      const newConversationSelector =
        `${ACTIVE_WORKSPACE_TAB} [data-testid="project-row-${projectId}"] ` +
        '[data-testid="project-new-conversation-button"]'
      await control.command('waitFor', newConversationSelector, { timeoutMs: uiTimeoutMs })
      await waitForUnreadCount(control, 0, uiTimeoutMs)

      const tasks = []
      for (const [index, task] of TASKS.entries()) {
        tasks.push(await sendTask(control, newConversationSelector, task, uiTimeoutMs))
        const stream = await waitForStream(task.prompt)
        await control.command('clickWhenEnabled', newConversationSelector, {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
        finishTask(task, stream)
        await waitForUnreadCount(control, index + 1, uiTimeoutMs)
      }

      const boardTabId = await ensureBoardTab(control, uiTimeoutMs)
      await control.command('click', `[data-testid="workspace-tab-select-${boardTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-content-${boardTabId}"][aria-hidden="false"]`,
        { timeoutMs: uiTimeoutMs }
      )

      await openTaskNotification(control, tasks[0].taskId, uiTimeoutMs)
      const firstActiveTabId = await activeWorkspaceTabId(control)
      assert.notEqual(
        firstActiveTabId,
        boardTabId,
        'Opening a task notification replaced the active board tab'
      )
      assert.match(
        firstActiveTabId,
        /^(fixed-task|task-)/,
        'Opening a task notification did not activate a task tab'
      )
      await waitForCurrentRuntimeTask(control, tasks[0].taskId, TASKS[0].completion, uiTimeoutMs)
      const afterFirst = await workspaceSnapshot(control)
      const taskTabsAfterFirst = workspaceTabTestIds(afterFirst, 'task')
      assert.equal(taskTabsAfterFirst.length, 1, 'The notification created a duplicate task tab')
      assert.ok(
        workspaceTabTestIds(afterFirst, 'board').includes(`workspace-tab-${boardTabId}`),
        'The board tab disappeared after opening a task notification'
      )

      await openTaskNotification(control, tasks[1].taskId, uiTimeoutMs)
      const secondActiveTabId = await activeWorkspaceTabId(control)
      assert.equal(
        secondActiveTabId,
        firstActiveTabId,
        'A second task notification created a new tab instead of reusing the task tab'
      )
      await waitForCurrentRuntimeTask(control, tasks[1].taskId, TASKS[1].completion, uiTimeoutMs)
      const afterSecond = await workspaceSnapshot(control)
      assert.deepEqual(
        workspaceTabTestIds(afterSecond, 'task'),
        taskTabsAfterFirst,
        'Reusing the task tab changed the set of open task tabs'
      )
      assert.ok(
        workspaceTabTestIds(afterSecond, 'board').includes(`workspace-tab-${boardTabId}`),
        'The board tab was replaced while reopening task notifications'
      )
      await waitForUnreadCount(control, 0, uiTimeoutMs)
    },

    cleanup() {
      for (const stream of streams.values()) stream.response.end()
      streams.clear()
    },

    diagnostics() {
      return { requestCount }
    },
  }
}
