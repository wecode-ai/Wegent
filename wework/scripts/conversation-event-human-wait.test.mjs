import assert from 'node:assert/strict'
import { expect, test, vi } from 'vitest'
import { createEventHumanWait } from '../e2e/desktop/modules/conversation-event-human-wait.mjs'

test.each([
  'available',
  'unavailable',
  'malformed-subscriptions',
  'formatter-failure',
  'counter-failure',
  'output-failure',
])('preserves the original failure and diagnostic privacy: %s', verifyMissingAnswerDiagnostics)

async function verifyMissingAnswerDiagnostics(scenario) {
  const unavailable = scenario === 'unavailable'
  const task = {
    taskId: 'question-task',
    threadId: 'question-thread',
    running: false,
    status: 'completed',
    interactionStatus: 'awaitingUserReply',
    executionState: { phase: 'queued', revision: '19', latestTurnId: 'question-turn' },
    runtimeHandle: {
      executionRequest: { prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_CREDENTIAL' },
      connectionEventSubscriptions: [
        { subscription_key: 'event_human', status: 'pending', events: ['PRIVATE_EVENT'] },
      ],
    },
  }
  const control = {
    command: vi.fn(async action => {
      if (action === 'setMainWindowSize') return JSON.stringify({ width: 1200, height: 800 })
      if (action === 'getElementCount') return '0'
      if (action === 'getElementMetrics')
        return JSON.stringify([{ scrollWidth: 400, clientWidth: 400 }])
      if (action === 'getAttribute') return 'A'.repeat(100)
      return ''
    }),
  }
  const rpc = vi.fn(async (_control, method) => {
    if (unavailable) throw new Error('PRIVATE_DIAGNOSTIC_FAILURE')
    if (method === 'runtime.capacity.get')
      return {
        maxConcurrentTasks: 2,
        maxConcurrentStandInTasks: 1,
        maxConcurrentAgentTasks: 1,
        limit: 4,
        active: 3,
        queued: 1,
        active_task_ids: [task.taskId, 'event-human-capacity-blocker', 'PRIVATE_OTHER_TASK'],
        categories: {
          personal: {
            active: 2,
            queued: 1,
            limit: 2,
            active_task_ids: [task.taskId, 'event-human-capacity-blocker'],
          },
          standIn: { active: 0, queued: 0, limit: 1, active_task_ids: [] },
          agent: { active: 1, queued: 0, limit: 1, active_task_ids: ['PRIVATE_OTHER_TASK'] },
        },
      }
    return { task: { taskId: 'blocker', running: true, executionState: { phase: 'running' } } }
  })
  const observedTask = { ...task }
  if (scenario === 'malformed-subscriptions')
    observedTask.runtimeHandle = {
      connectionEventSubscriptions: { credential: 'PRIVATE_MALFORMED_SUBSCRIPTIONS' },
    }
  if (scenario === 'formatter-failure')
    Object.defineProperty(observedTask, 'executionState', {
      get() {
        throw new Error('PRIVATE_FORMATTER_FAILURE')
      },
    })
  const getTask = vi.fn().mockResolvedValueOnce({ task }).mockResolvedValue({ task: observedTask })
  const readRequestCount = vi.fn().mockReturnValue(5)
  if (scenario === 'counter-failure')
    readRequestCount.mockReturnValueOnce(5).mockImplementation(() => {
      throw new Error('PRIVATE_COUNTER_FAILURE')
    })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    if (scenario === 'output-failure') throw new Error('PRIVATE_OUTPUT_FAILURE')
  })
  const originalError = new assert.AssertionError({ message: 'Original held model assertion' })
  const fail = vi.spyOn(assert, 'fail').mockImplementation(() => {
    throw originalError
  })
  const human = createEventHumanWait({
    rpc,
    workspacePath: '/workspace',
    uiTimeoutMs: 0,
    captureScreenshot: vi.fn(),
  })
  try {
    await expect(
      human.verifyPending(control, { taskId: task.taskId }, getTask, 5, readRequestCount)
    ).rejects.toBe(originalError)
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      'Missing held model request event-human-answer: null'
    )
    expect(rpc.mock.calls.map(call => call[1])).toEqual([
      'runtime.tasks.get',
      'runtime.capacity.get',
    ])
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/PRIVATE_/)
    if (['malformed-subscriptions', 'formatter-failure', 'counter-failure'].includes(scenario)) {
      expect(error).not.toHaveBeenCalled()
      return
    }
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[conversation-event-human-wait] answer-model-wait-failed',
      expect.objectContaining({
        task: expect.objectContaining({ taskId: task.taskId, phase: 'queued', revision: '19' }),
        blocker: unavailable ? null : expect.objectContaining({ taskId: 'blocker', running: true }),
        capacity: unavailable
          ? null
          : {
              active: 3,
              queued: 1,
              maxConcurrentTasks: 2,
              questionActive: true,
              blockerActive: true,
              personal: { active: 2, queued: 1, limit: 2 },
            },
        modelRequestsSinceEvent: 0,
        heldModelRequests: [],
        unavailableObservations: unavailable ? [1, 2] : [],
      })
    )
  } finally {
    fail.mockRestore()
    error.mockRestore()
  }
}
