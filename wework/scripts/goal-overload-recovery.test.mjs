// @vitest-environment node

import assert from 'node:assert/strict'
import { Readable, PassThrough } from 'node:stream'
import { afterEach, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ rpc: null, wait: null }))
vi.mock('../e2e/desktop/scenarios/model-overload-recovery.scenario.mjs', () => ({
  createDesktopScenario: () => ({
    verify: async () => {},
    handleHttp: async () => false,
    overloadTerminalGate: { release: async () => {} },
  }),
}))
vi.mock('../e2e/desktop/modules/goal-admission-recovery.mjs', () => ({
  createGoalAdmissionRecovery: () => ({ active: false }),
}))
vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  ACTIVE_COMPOSER_SELECTOR: 'composer',
  ACTIVE_WORKBENCH_SELECTOR: 'workbench',
  createSingleRootLocalProject: async () => {},
  selectE2EModel: async () => {},
}))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', () => ({
  waitForWorkbenchDebugState: (...args) => fixture.wait(...args),
}))
vi.mock('../e2e/desktop/modules/runtime-request.mjs', () => ({
  fetchLocalRuntime: (...args) => fixture.rpc(...args),
}))
vi.mock('node:fs/promises', () => ({ mkdir: async () => {}, readFile: async () => '' }))

import { createDesktopScenario } from '../e2e/desktop/scenarios/goal-overload-recovery.scenario.mjs'

afterEach(() => vi.useRealTimers())

test('recovery admits the native backoff and cancels the Goal before releasing a held response on failure', async () => {
  vi.useFakeTimers()
  let goal = {
    status: 'blocked',
    objective: 'goal',
    threadId: 'thread',
    createdAt: 1,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    tokenBudget: null,
  }
  let active = false
  let recovered
  const ready = new Promise(resolve => {
    recovered = resolve
  })
  const cleanup = []
  const failure = new Error('Inspecting the recovered Goal failed')
  const scenario = createDesktopScenario({
    workspacePath: '/fixture',
    uiTimeoutMs: 10_000,
    modelResponseTimeoutMs: 30_000,
  })
  const model = async () => {
    const request = Readable.from([JSON.stringify({ input: 'WEWORK_OVERLOADED_GOAL_continue' })])
    request.method = 'POST'
    const response = new PassThrough()
    response.writeHead = () => {
      if (active) recovered()
      return response
    }
    response.resume()
    response.on('finish', () => {
      if (active) cleanup.push(goal ? 'response-with-active-goal' : 'response-after-clear')
    })
    await scenario.handleHttp(request, response, new URL('http://fixture/v1/responses'))
  }
  fixture.rpc = async (_, __, init) => {
    const { method } = JSON.parse(init.body)
    if (method.endsWith('.clear')) {
      cleanup.push('clear')
      goal = null
    }
    return new Response(JSON.stringify({ ok: true, result: { accepted: true, goal } }))
  }
  const snapshot = () => ({
    pane: { goal, status: { isBusy: active } },
    workbench: {
      activeLifecycle: { goalStatus: goal?.status },
      currentRuntimeTask: { taskId: 'task' },
    },
  })
  fixture.wait = async (_, predicate, message, timeoutMs = 10_000) => {
    if (!predicate(snapshot())) {
      await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
      ])
    }
    assert.equal(predicate(snapshot()), true)
    return snapshot()
  }
  let heldResponse
  const control = {
    async command(action) {
      if (action === 'getLocationOrigin') return 'http://fixture'
      if (action === 'waitFor') throw failure
      if (action === 'press') {
        await model()
        setTimeout(() => {
          if (!goal) return
          active = true
          goal = { ...goal, status: 'active' }
          heldResponse = model()
        }, 10_100)
      }
    },
  }
  const verification = scenario.verify(control).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(10_100)
  assert.equal(await verification, failure)
  await heldResponse
  assert.deepEqual(cleanup, ['clear', 'response-after-clear'])
})
