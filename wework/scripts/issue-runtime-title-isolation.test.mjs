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

test('waits for the new turn and its exact visible response without counting mounted rows', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const { method } = JSON.parse(options.body)
    return new Response(
      JSON.stringify({
        ok: true,
        result: method === 'runtime.tasks.rename' ? { accepted: true } : issue,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  })
  const snapshots = [snapshot(previous), snapshot(previous), snapshot()]
  const calls = []
  const control = {
    setScenario: vi.fn(),
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getLocationOrigin') return 'http://executor.test'
      if (action === 'getWorkbenchDebugSnapshot') return JSON.stringify(snapshots.shift())
      if (['fill', 'press', 'waitFor'].includes(action)) return ''
      throw new Error(`Mounted row counts cannot identify a new turn: ${action}`)
    },
  }
  await verifyIssueRuntimeTitleIsolation(control, '#task-tab', { id: 1 }, issue, binding)
  const responseWait = calls.find(
    call => call.action === 'waitFor' && call.selector.includes('data-message-id')
  )
  assert.ok(responseWait.selector.includes('follow-up-assistant'))
  assert.equal(responseWait.options.visible, true)
  assert.equal(snapshots.length, 0, 'The previous completion incorrectly satisfied the follow-up')
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
