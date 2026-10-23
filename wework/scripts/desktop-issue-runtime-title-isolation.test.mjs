import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

const { requestExecutor } = vi.hoisted(() => ({ requestExecutor: vi.fn() }))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor }))

import { verifyIssueRuntimeTitleIsolation } from '../e2e/desktop/modules/issue-runtime-title-isolation.mjs'
import {
  CHECKPOINT_TASK_COMPLETION_TEXT,
  DEFAULT_STEP_TIMEOUT_MS,
} from '../e2e/desktop/modules/shared.mjs'

const binding = { device_id: 'device-1', task_id: 'task-1' }
const issue = { id: 'ISSUE-1', title: 'Shared Issue', version: 4 }
const project = { id: 'project-1' }
const content = '[data-testid="workspace-tab-content-task-1"]'

beforeEach(() => {
  vi.useFakeTimers()
  requestExecutor
    .mockReset()
    .mockImplementation(async (_control, method) =>
      method === 'runtime.tasks.rename' ? { accepted: true } : issue
    )
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function createControl({
  taskId = binding.task_id,
  turnId = 'new-turn',
  outcome = 'succeeded',
} = {}) {
  let submitted = false
  const commands = []
  return {
    commands,
    setScenario: vi.fn(),
    awaitNextScenarioRequest: vi.fn(async () => ({})),
    async command(action, selector, options = {}) {
      commands.push({ action, selector, options })
      // A virtualized/reconciled conversation can keep the same DOM row count.
      if (action === 'getElementCount') return selector.includes('pause-response') ? '0' : '1'
      if (action === 'press') {
        assert.equal(submitted, false, 'The follow-up was submitted twice')
        submitted = true
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          workbench: {
            activeTask: {
              taskId: submitted ? taskId : binding.task_id,
              title: `Private conversation for ${issue.id}`,
            },
            lifecycleCurrentTaskRunning: false,
            activeLifecycle: {
              turn: {
                latestId: submitted ? turnId : 'previous-turn',
                outcome: submitted ? outcome : 'succeeded',
              },
            },
          },
        })
      }
      return ''
    },
  }
}

test('recognizes a new completed turn even when assistant DOM row count does not grow', async () => {
  const control = createControl()
  const verification = verifyIssueRuntimeTitleIsolation(
    control,
    content,
    project,
    issue,
    binding
  ).then(
    () => null,
    error => error
  )

  await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS + 100)

  assert.equal(await verification, null)
  const responseWait = control.commands.find(
    command =>
      command.action === 'waitFor' && command.options.text === CHECKPOINT_TASK_COMPLETION_TEXT
  )
  assert.ok(responseWait.selector.includes('runtime-view:new-turn:assistant'))
  assert.equal(responseWait.options.visible, true)
  assert.equal(requestExecutor.mock.calls.filter(call => call[1] === 'todos.get').length, 2)
})

for (const [description, result] of [
  ['the previous completed turn', { turnId: 'previous-turn' }],
  ['a failed new turn', { outcome: 'failed' }],
  ['another task completing', { taskId: 'other-task' }],
]) {
  test(`does not treat ${description} as the renamed follow-up completing`, async () => {
    const control = createControl(result)
    const verification = verifyIssueRuntimeTitleIsolation(
      control,
      content,
      project,
      issue,
      binding
    ).then(
      () => null,
      error => error
    )

    await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS + 100)

    assert.match(String(await verification), /did not finish its follow-up turn/)
    assert.equal(requestExecutor.mock.calls.filter(call => call[1] === 'todos.get').length, 1)
  })
}
