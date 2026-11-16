import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

function runningTask(value, taskId) {
  if (!value || typeof value !== 'object') return null
  if (value.taskId === taskId && typeof value.running === 'boolean') return value
  for (const child of Object.values(value)) {
    const task = runningTask(child, taskId)
    if (task) return task
  }
  return null
}

export async function prepareGoalCompletionRace(control, address) {
  const gates = runtimeTransportGates(control)
  let resultDirectory
  await gates.arm({
    id: 'goal-old-running-history',
    kind: 'response',
    name: 'runtime.tasks.transcript',
    holdFollowing: true,
    where: [
      { path: 'params.taskId', equals: address.taskId },
      { path: 'result.turns.*.status', equals: 'streaming' },
    ],
  })
  // The ordinary recovery path starts a canonical transcript read, not a fabricated snapshot.
  await control.command('dispatchRuntimeEventLagged', 'body')
  await gates.wait('goal-old-running-history')
  await gates.arm({
    id: 'goal-old-running-work',
    kind: 'response',
    name: 'runtime.tasks.list',
    holdFollowing: true,
    where: [
      { path: 'result.**.taskId', equals: address.taskId },
      { path: 'result.**.running', equals: true },
    ],
  })
  // The ordinary cross-window refresh reads the real sidebar snapshot independently.
  await control.command('refreshRuntimeWork', 'body', { value: JSON.stringify(address) })
  const staleWork = await gates.wait('goal-old-running-work')
  const task = runningTask(staleWork.value.result, address.taskId)
  assert.equal(task?.running, true, 'The held task snapshot was not actually running')
  assert.equal(
    task.completedAt ?? null,
    null,
    'The stale snapshot already carried authoritative completion'
  )
  await gates.arm({
    id: 'goal-complete-before-settled',
    kind: 'event',
    name: 'runtime.goal.updated',
    hold: false,
    where: [
      { path: 'payload.taskId', equals: address.taskId },
      { path: 'payload.data.goal.status', equals: 'complete' },
    ],
  })
  await gates.arm({
    id: 'goal-final-turn-settled',
    kind: 'event',
    name: 'response.completed',
    where: [{ path: 'payload.taskId', equals: address.taskId }],
  })
  const lifecycle = async () =>
    JSON.parse(
      await control.command('getRuntimeLifecycleState', 'body', { value: JSON.stringify(address) })
    )
  return {
    async settleBeforeStaleReads(executorLogPath) {
      resultDirectory = dirname(executorLogPath)
      await gates.wait('goal-complete-before-settled')
      await gates.wait('goal-final-turn-settled')
      await gates.release('goal-final-turn-settled')
      let settledState
      const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
      while (Date.now() < deadline) {
        settledState = await lifecycle()
        if (
          settledState?.goalStatus === 'complete' &&
          settledState.execution.phase === 'idle' &&
          settledState.turn.active === false
        )
          break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await writeFile(
        `${dirname(executorLogPath)}/goal-before-stale-reads.json`,
        JSON.stringify(settledState, null, 2)
      )
      assert.equal(
        settledState?.goalStatus,
        'complete',
        'The real Goal completion was not consumed before settlement'
      )
      assert.equal(
        settledState.execution.phase,
        'idle',
        'Goal completion before turn settlement did not become idle'
      )
      assert.equal(settledState.turn.active, false)
      assert.equal(settledState.derived.canSend, true)
      await gates.release('goal-old-running-work')
      await gates.release('goal-old-running-history')
      const afterStale = await lifecycle()
      await writeFile(
        `${dirname(executorLogPath)}/goal-after-stale-reads.json`,
        JSON.stringify(afterStale, null, 2)
      )
      assert.equal(
        afterStale.execution.phase,
        'idle',
        'A real stale running snapshot revived the completed Goal'
      )
      assert.equal(afterStale.turn.active, false, 'Real stale history revived a completed turn')
      assert.equal(
        afterStale.derived.canSend,
        true,
        'Stale history disabled the completed Goal composer'
      )
      const evidence = await gates.save(
        dirname(executorLogPath),
        'goal-complete-history-race.json',
        [
          'goal-old-running-history',
          'goal-old-running-work',
          'goal-complete-before-settled',
          'goal-final-turn-settled',
        ]
      )
      const complete = evidence['goal-complete-before-settled']
      const settled = evidence['goal-final-turn-settled']
      assert.ok(complete.deliveredAt < settled.deliveredAt)
      for (const id of ['goal-old-running-history', 'goal-old-running-work']) {
        assert.ok(evidence[id].capturedAt < complete.deliveredAt)
        assert.ok(settled.deliveredAt < evidence[id].deliveredAt)
      }
      return evidence
    },
    releaseFreshReads: () => gates.reset(['goal-complete-before-settled']),
    async replayComplete() {
      await gates.release('goal-complete-before-settled')
      await gates.save(resultDirectory, 'goal-late-completion-replay.json', [
        'goal-complete-before-settled',
      ])
      await writeFile(
        `${resultDirectory}/goal-live-continuation-after-replay.json`,
        JSON.stringify(await lifecycle(), null, 2)
      )
    },
    reset: gates.reset,
  }
}
