import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { waitForCompletedRuntimeTaskThread } from './runtime-task-evidence.mjs'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const OBJECTIVE = 'WEWORK_UPGRADE_PERSISTED_GOAL'
const FIRST_REPLY = 'WEWORK_UPGRADE_GOAL_ACCOUNTED_REPLY'

/** Exercise persisted native Goals through the real task owner and startup recovery. */
export function createUpgradeGoalContinuity(pair, control, timeoutMs) {
  const enabled = pair.to.afterStopPreparation === 1
  const held = new Set()
  const phases = []
  let address
  let original
  let requests = 0
  let armedAt = 0
  let holding = false
  const rpc = (method, params) => requestExecutor(control(), method, params, timeoutMs)
  const waitInference = minimum =>
    waitForValue(
      async () => requests,
      count => count >= minimum,
      'Persisted Goal did not automatically reach inference',
      timeoutMs
    )
  const finish = response => {
    if (!response.destroyed)
      response.end(
        createSse([
          assistantMessage('Upgrade Goal observation finished'),
          responseCompleted('upgrade-goal-finished'),
        ])
      )
  }
  return {
    handleModel(body, response) {
      if (!enabled || !holding || !JSON.stringify(body.input ?? body.messages).includes(OBJECTIVE))
        return false
      requests++
      const id = `upgrade-goal-${requests}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (requests === 1) {
        const completed = responseCompleted(id)
        completed.response.usage = {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
        }
        response.end(createSse([responseCreated(id), assistantMessage(FIRST_REPLY), completed]))
      } else {
        assert.ok(
          JSON.stringify(body.input ?? body.messages).includes(FIRST_REPLY),
          'Goal continuation lost its previous assistant output'
        )
        response.write(createSse([responseCreated(id)]))
        response.flushHeaders()
        held.add(response)
        response.once('close', () => held.delete(response))
      }
      return true
    },
    async arm() {
      if (!enabled) return
      if (!address) {
        const snapshot = JSON.parse(await control().command('getWorkbenchDebugSnapshot', 'body'))
        address = snapshot.workbench?.currentRuntimeTask
        assert.ok(address?.taskId)
      }
      holding = true
      armedAt = requests
      const result = await rpc('runtime.tasks.goal.set', {
        address,
        objective: OBJECTIVE,
        status: 'active',
        tokenBudget: 123456,
      })
      assert.equal(result.success, true)
      await waitInference(armedAt === 0 ? 2 : armedAt + 1)
      original = (await rpc('runtime.tasks.goal.get', { address })).goal
      assert.equal(original.status, 'active')
      assert.ok(original.tokensUsed > 0, 'Source Goal must persist nonzero accounting')
      armedAt = requests
    },
    async verifyResumed(stage) {
      if (!enabled) return
      // Observe inference before issuing any task/Goal read that could load a session.
      await waitInference(armedAt + 1)
      const resumed = (await rpc('runtime.tasks.goal.get', { address })).goal
      for (const key of ['id', 'threadId', 'objective', 'status', 'tokenBudget', 'createdAt'])
        assert.deepEqual(resumed[key], original[key], `${stage} lost Goal ${key}`)
      assert.ok(resumed.tokensUsed >= original.tokensUsed, `${stage} reset Goal accounting`)
      assert.ok(
        resumed.timeUsedSeconds >= original.timeUsedSeconds,
        `${stage} reset Goal elapsed time`
      )
      phases.push(stage)
      const paused = await rpc('runtime.tasks.goal.set', { address, status: 'paused' })
      assert.equal(paused.goal.status, 'paused')
      holding = false
      for (const response of held) finish(response)
      held.clear()
      await waitForCompletedRuntimeTaskThread(control(), address.taskId, timeoutMs)
    },
    beforeRestart() {
      armedAt = requests
    },
    cleanup() {
      for (const response of held) finish(response)
      held.clear()
    },
    evidence() {
      return enabled
        ? { originalGoalPreserved: true, nonzeroAccounting: true, automaticallyResumed: phases }
        : undefined
    },
  }
}
