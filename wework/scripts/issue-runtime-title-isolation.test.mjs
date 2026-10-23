import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'
import { verifyIssueRuntimeTitleIsolation } from '../e2e/desktop/modules/issue-runtime-title-isolation.mjs'
import { CHECKPOINT_TASK_COMPLETION_TEXT } from '../e2e/desktop/modules/shared.mjs'

vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

const issue = { id: 'issue-1', title: 'Public Issue', version: 3 }
const binding = { device_id: 'local', task_id: 'runtime-1' }
const content = '[data-testid="workspace-tab-content-task-1"]'

function fixture({
  turnId = 'follow-up',
  outcome = 'succeeded',
  running = false,
  taskId = binding.task_id,
  staleReply = false,
} = {}) {
  let clock = 0
  let snapshots = 0
  const commands = []
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  vi.mocked(requestExecutor).mockImplementation(async (_control, method) => {
    if (method === 'runtime.tasks.rename') return { accepted: true }
    if (method === 'todos.get') return issue
    throw new Error(`Unexpected RPC: ${method}`)
  })
  const control = {
    setScenario: vi.fn(),
    async command(action, selector, options = {}) {
      commands.push({ action, selector, options })
      if (action === 'getWorkbenchDebugSnapshot') {
        const initial = snapshots++ === 0
        clock += 6000
        return JSON.stringify({
          workbench: {
            currentRuntimeTask: { taskId: initial ? binding.task_id : taskId },
            activeTask: { title: 'Private conversation for issue-1' },
            activeLifecycle: { turn: { latestId: initial ? 'original' : turnId, outcome } },
            lifecycleCurrentTaskRunning: initial ? false : running,
          },
          pane: {
            messageSummary: {
              lastMessage: {
                id: `runtime-view:${initial || staleReply ? 'original' : turnId}:assistant`,
                role: 'assistant',
                status: 'done',
              },
            },
          },
        })
      }
      if (['fill', 'press', 'waitFor'].includes(action)) return ''
      throw new Error(`Unexpected action: ${action}; mounted DOM counts are not turn evidence`)
    },
  }
  return { control, commands }
}

test('verifies a new completed turn even when virtualization keeps the mounted reply count unchanged', async () => {
  const { control, commands } = fixture()
  await verifyIssueRuntimeTitleIsolation(control, content, { id: 1 }, issue, binding)
  assert.ok(
    commands.some(
      command =>
        command.action === 'waitFor' &&
        command.selector.includes('runtime-view:follow-up:assistant') &&
        command.options.text === CHECKPOINT_TASK_COMPLETION_TEXT
    )
  )
  assert.equal(
    commands.some(command => command.action === 'getElementCount'),
    false
  )
})

for (const [name, state] of [
  ['the previous completed turn', { turnId: 'original' }],
  ['a failed follow-up', { outcome: 'failed' }],
  ['a still-running follow-up', { running: true }],
  ['a completed turn from another task', { taskId: 'runtime-other' }],
  ['the previous reply with a newer lifecycle snapshot', { staleReply: true }],
]) {
  test(`rejects ${name}`, async () => {
    const { control } = fixture(state)
    await assert.rejects(
      verifyIssueRuntimeTitleIsolation(control, content, { id: 1 }, issue, binding),
      /The renamed conversation did not finish its follow-up turn/
    )
  })
}
