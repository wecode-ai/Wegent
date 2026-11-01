import assert from 'node:assert/strict'

// Delay original transport deliveries to verify recovery survives an older terminal read.
export async function verifyOverloadHistoryRace({
  gates,
  nativeGate,
  control,
  address,
  releaseOverload,
  resultDir,
}) {
  await gates.arm({
    id: 'live-recovery',
    kind: 'event',
    name: 'response.block.created',
    hold: true,
    where: [
      { path: 'payload.taskId', equals: address.taskId },
      { path: 'payload.data.block.tool_name', equals: 'runtime_reconnecting' },
    ],
  })
  await nativeGate.arm()
  releaseOverload()
  const nativeFailure = await nativeGate.wait()
  assert.equal(nativeFailure.notification, 'turn/completed')
  assert.equal(nativeFailure.status, 'failed')
  assert.ok(nativeFailure.turnId, 'The real native failure has no turn identity')
  await gates.arm({
    id: 'recovered-terminal-history',
    kind: 'response',
    name: 'runtime.tasks.transcript',
    where: [
      { path: 'params.taskId', equals: address.taskId },
      { path: 'result.turns.*.id', equals: nativeFailure.turnId },
      { path: 'result.turns.*.status', equals: 'done' },
    ],
  })
  // Recovery normalizes this failed turn to completed history while the task
  // stays active. Deliver that older terminal history after renderer recovery.
  await nativeGate.release()
  await gates.wait('recovered-terminal-history', () =>
    control.command('dispatchRuntimeEventLagged', 'body')
  )
  const history = await gates.read('recovered-terminal-history')
  const turn = history.value.result.turns.find(turn => turn.id === nativeFailure.turnId)
  assert.equal(turn?.status, 'done', 'Recovery did not normalize the actual native failed turn')
  assert.equal(turn.error == null, true, 'Recovered history retained a terminal error')
  assert.equal(history.value.result.running, true, 'The historical turn ended the recovering task')
  await gates.wait('live-recovery')
  await gates.release('live-recovery')
  await gates.release('recovered-terminal-history')
  const ordering = await gates.save(resultDir, 'overload-history-race.json', [
    'recovered-terminal-history',
    'live-recovery',
  ])
  assert.ok(
    ordering['recovered-terminal-history'].capturedAt < ordering['live-recovery'].deliveredAt
  )
  assert.ok(
    ordering['live-recovery'].deliveredAt < ordering['recovered-terminal-history'].deliveredAt
  )
}
