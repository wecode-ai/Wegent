import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { verifyBusyTurnGoalHandoff } from '../e2e/desktop/modules/goal-flows.mjs'
import {
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  GOAL_BUSY_COMPLETION_TEXT,
  GOAL_BUSY_OBJECTIVE,
  GOAL_BUSY_PLAN_TEXT,
  MODEL_PROVIDER_ID,
  MODEL_REQUEST_TIMEOUT_MS,
} from '../e2e/desktop/modules/shared.mjs'

const validHandoffLog = 'codex shared turn request started\ncodex shared goal turn awaiting\n'
const temporaryDirectories = []

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
})

async function startHandoff({ delayMs = 16_000, log = validHandoffLog } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-queued-goal-'))
  temporaryDirectories.push(directory)
  const executorLogPath = join(directory, 'executor.log')
  await writeFile(executorLogPath, '')
  vi.useFakeTimers()
  let selected = false
  let phase = 'blank'
  let queued = false
  let releasedAt
  const commands = []
  const control = Object.assign(Object.create(DesktopE2EServer.prototype), {
    scenarioRequests: new Map(),
    scenarioWaiters: new Map(),
    fatalErrorPromise: new Promise(() => {}),
    setScenario: vi.fn(),
    releaseGoalBusyPlan: vi.fn(() => {
      releasedAt = Date.now()
      if (delayMs === null) return
      setTimeout(() => {
        appendFileSync(executorLogPath, log)
        phase = 'complete'
        control.recordScenarioRequest('goal_busy_handoff', {})
      }, delayMs)
    }),
    async command(action, selector, options = {}) {
      commands.push({ action, selector, options })
      if (action === 'click' && selector.includes('new-chat-button')) selected = false
      if (action === 'clickWhenEnabled' && selector.includes('runtime-local-task-row')) {
        selected = true
      }
      if (action === 'press' && options.key === 'Enter') {
        if (phase === 'blank') {
          selected = true
          phase = 'planning'
          this.recordScenarioRequest('goal_busy_handoff', {})
        } else {
          assert.equal(queued, false, 'The Goal was submitted more than once')
          queued = true
        }
      }
      if (action === 'snapshot') {
        return JSON.stringify({
          testIds: [
            'plan-mode-pill',
            ...(phase === 'planning' ? ['runtime-local-task-running-queued-goal'] : []),
            ...(selected && phase === 'planning'
              ? ['pause-response-button', 'thinking-indicator']
              : []),
            ...(selected && queued && phase === 'planning'
              ? ['conversation-queue-panel', 'goal-status-bar']
              : []),
            ...(phase === 'complete' ? ['send-message-button'] : []),
          ],
          text: phase === 'complete' ? `${GOAL_BUSY_PLAN_TEXT}\n${GOAL_BUSY_COMPLETION_TEXT}` : '',
        })
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          workbench: { currentRuntimeTask: selected ? { taskId: 'queued-goal' } : null },
        })
      }
      if (action === 'getElementCount') return '0'
      if (action === 'getText') return DEFAULT_MODEL_LABEL
      if (action === 'getAttribute') return MODEL_PROVIDER_ID
      if (action === 'waitFor' && selector.includes('conversation-queue-panel')) {
        assert.ok(selected && queued)
        assert.equal(options.text, GOAL_BUSY_OBJECTIVE)
      }
      if (action === 'waitFor' && selector.includes('message-assistant')) {
        assert.equal(phase, 'complete', 'Goal UI waiting started before the model request')
        assert.equal(options.text, GOAL_BUSY_COMPLETION_TEXT)
      }
      return ''
    },
  })
  const result = verifyBusyTurnGoalHandoff({
    composerSelector: '[data-testid="chat-message-input"]',
    control,
    executorLogPath,
  }).then(
    () => null,
    error => error
  )
  await vi.waitFor(() => assert.equal(control.releaseGoalBusyPlan.mock.calls.length, 1))
  return { commands, control, releasedAt, result }
}

test('allows native queued Goal startup beyond the UI budget without resubmission', async () => {
  const { commands, control, releasedAt, result } = await startHandoff()
  let settled = false
  void result.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(releasedAt + DEFAULT_STEP_TIMEOUT_MS + 1 - Date.now())
  assert.equal(settled, false)
  await vi.advanceTimersByTimeAsync(releasedAt + 16_000 - Date.now())
  assert.equal(await result, null)
  assert.equal(control.scenarioRequests.get('goal_busy_handoff').length, 2)
  assert.equal(control.releaseGoalBusyPlan.mock.calls.length, 1)
  assert.equal(commands.filter(command => command.action === 'press').length, 2)
  for (const { selector, options } of commands.filter(command => command.options.timeoutMs)) {
    if (!selector.includes('model-selector-button')) {
      assert.equal(options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
    }
  }
  assert.equal(vi.getTimerCount(), 0)
})

test('still rejects a queued Goal that never reaches the model within its readiness budget', async () => {
  const { releasedAt, result } = await startHandoff({ delayMs: null })
  await vi.advanceTimersByTimeAsync(releasedAt + MODEL_REQUEST_TIMEOUT_MS + 1 - Date.now())
  assert.match(
    (await result)?.message ?? '',
    /The queued Goal did not start after the planning turn completed/
  )
})

test.each([
  {
    log: `codex shared turn request started\n${validHandoffLog}`,
    error: /did not keep exactly one ordinary planning turn/,
  },
  {
    log: `${validHandoffLog}codex shared goal turn awaiting\n`,
    error: /did not use the Codex initial Goal protocol/,
  },
])('retains the native Goal protocol assertion for $error', async ({ log, error }) => {
  const { releasedAt, result } = await startHandoff({ log })
  await vi.advanceTimersByTimeAsync(releasedAt + 16_000 - Date.now())
  assert.match((await result)?.message ?? '', error)
})
