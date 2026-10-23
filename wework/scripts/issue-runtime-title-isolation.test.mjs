import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  completedRenamedConversationState,
  verifyIssueRuntimeTitleIsolation,
} from '../e2e/desktop/modules/issue-runtime-title-isolation.mjs'

const binding = { device_id: 'device', task_id: 'runtime-task' }
const issue = { id: 'ISSUE-1', title: 'Shared Issue title', version: 3 }
const title = `Private conversation for ${issue.id}`
const previous = { turnId: 'initial-turn', assistantMessageId: 'initial-assistant' }
const current = { turnId: 'follow-up-turn', assistantMessageId: 'follow-up-assistant' }

function snapshot(state = current) {
  const address = { deviceId: binding.device_id, taskId: binding.task_id }
  return {
    workbench: {
      currentRuntimeTask: address,
      activeTask: { taskId: binding.task_id, title },
      lifecycleCurrentTaskRunning: false,
      activeLifecycle: { turn: { latestId: state.turnId, outcome: 'succeeded' } },
    },
    pane: {
      currentRuntimeTask: address,
      messageSummary: {
        lastMessage: { id: state.assistantMessageId, role: 'assistant', status: 'done' },
      },
    },
  }
}

afterEach(() => vi.restoreAllMocks())

test('renames through the UI before observing the new turn and its exact visible response', async () => {
  const requests = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const request = JSON.parse(options.body)
    requests.push(request)
    assert.equal(request.method, 'todos.get', 'Runtime renames must use the UI refresh flow')
    return new Response(
      JSON.stringify({
        ok: true,
        result: issue,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  })
  const content = '[data-testid="workspace-tab-content-task-tab"]'
  const header =
    '[data-workspace-tab-portal-owner="task-tab"]:not([hidden]) [data-testid="conversation-rename-button"]'
  const dialog = '[data-testid="conversation-rename-input-overlay"]'
  const staleTitle = snapshot(previous)
  staleTitle.workbench.activeTask.title = 'Draft first-message title'
  const snapshots = [staleTitle, snapshot(previous), snapshot(previous), snapshot()]
  const calls = []
  let dialogOpened = false
  let renameFilled = false
  let renameSaved = false
  let dialogClosed = false
  const control = {
    setScenario: vi.fn(),
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') {
        assert.equal(selector, content)
        assert.equal(options.value, 'data-workspace-tab-content')
        return 'task-tab'
      }
      if (action === 'clickWhenEnabled') {
        if (selector === header) dialogOpened = true
        else {
          assert.equal(selector, `${dialog} [data-testid="conversation-rename-confirm"]`)
          assert.equal(renameFilled, true, 'The rename title was not filled before saving')
          renameSaved = true
        }
        return ''
      }
      if (action === 'fill' && selector === `${dialog} [data-testid="conversation-rename-input"]`) {
        assert.equal(dialogOpened, true)
        assert.equal(options.value, title)
        renameFilled = true
        return ''
      }
      if (action === 'waitFor' && selector === dialog) {
        assert.equal(renameSaved, true)
        assert.equal(options.visible, false)
        dialogClosed = true
        return ''
      }
      if (action === 'getLocationOrigin') return 'http://executor.test'
      if (action === 'getWorkbenchDebugSnapshot') {
        assert.equal(dialogClosed, true, 'The UI rename must finish its refresh before observing')
        return JSON.stringify(snapshots.shift())
      }
      if (['fill', 'press', 'waitFor'].includes(action)) return ''
      throw new Error(`Mounted row counts cannot identify a new turn: ${action}`)
    },
  }
  await verifyIssueRuntimeTitleIsolation(control, content, { id: 1 }, issue, binding)
  const responseWait = calls.find(
    call => call.action === 'waitFor' && call.selector.includes('data-message-id')
  )
  assert.ok(responseWait.selector.includes('follow-up-assistant'))
  assert.equal(responseWait.options.visible, true)
  assert.equal(snapshots.length, 0, 'The previous completion incorrectly satisfied the follow-up')
  assert.equal(requests.length, 2, 'Both title-isolation checks must read the persisted Issue')
  for (const request of requests)
    assert.deepEqual(request.params, { project_id: 1, task_id: issue.id })
})

test('propagates an unfinished UI rename before sending a follow-up', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  const failure = new Error('Rename dialog remained open after a rejected save')
  const calls = []
  const control = {
    setScenario: vi.fn(),
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') return 'task-tab'
      if (action === 'waitFor' && options.visible === false) throw failure
      if (['clickWhenEnabled', 'fill', 'waitFor'].includes(action)) return ''
      throw new Error(`A failed rename must stop the flow: ${action}`)
    },
  }
  await assert.rejects(
    verifyIssueRuntimeTitleIsolation(control, '#task-tab', { id: 1 }, issue, binding),
    error => error === failure
  )
  assert.equal(fetch.mock.calls.length, 0)
  assert.equal(control.setScenario.mock.calls.length, 0)
  assert.equal(
    calls.some(call => call.action === 'press'),
    false
  )
})

test('accepts a new completed turn for the same renamed conversation', () => {
  assert.deepEqual(completedRenamedConversationState(snapshot(), binding, title, previous), current)
})

test.each([
  [
    'the previous turn',
    state => {
      state.workbench.activeLifecycle.turn.latestId = previous.turnId
    },
  ],
  [
    'the previous response',
    state => {
      state.pane.messageSummary.lastMessage.id = previous.assistantMessageId
    },
  ],
  [
    'a running turn',
    state => {
      state.workbench.lifecycleCurrentTaskRunning = true
    },
  ],
  [
    'a failed turn',
    state => {
      state.workbench.activeLifecycle.turn.outcome = 'failed'
    },
  ],
  [
    'a streaming response',
    state => {
      state.pane.messageSummary.lastMessage.status = 'streaming'
    },
  ],
  [
    'another active task',
    state => {
      state.workbench.activeTask.taskId = 'other-task'
    },
  ],
  [
    'another pane',
    state => {
      state.pane.currentRuntimeTask = { deviceId: 'other-device', taskId: 'other-task' }
    },
  ],
  [
    'a changed private title',
    state => {
      state.workbench.activeTask.title = issue.title
    },
  ],
])('rejects %s as evidence of a completed renamed follow-up', (_description, mutate) => {
  const state = snapshot()
  mutate(state)
  assert.equal(completedRenamedConversationState(state, binding, title, previous), null)
})
