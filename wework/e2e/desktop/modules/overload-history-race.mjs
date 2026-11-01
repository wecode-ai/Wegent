import assert from 'node:assert/strict'

// Delay original transport deliveries to verify recovery survives an older failed read.
export async function verifyOverloadHistoryRace({
  gates,
  nativeGate,
  control,
  address,
  releaseOverload,
  resultDir,
}) {
  await gates.arm({
    id: 'old-failed-history',
    kind: 'response',
    name: 'runtime.tasks.transcript',
    where: [
      { path: 'params.taskId', equals: address.taskId },
      { path: 'result.turns.*.status', equals: 'failed' },
    ],
  })
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
  // History is terminal only after the Executor receives the native boundary.
  // Hold renderer recovery instead so the older failed history still arrives last.
  await nativeGate.release()
  await gates.wait('old-failed-history', () =>
    control.command('dispatchRuntimeEventLagged', 'body')
  )
  const failedHistory = await gates.read('old-failed-history')
  assert.ok(
    failedHistory.value.result.turns.some(
      turn => turn.id === nativeFailure.turnId && turn.status === 'failed'
    ),
    'The held failed snapshot did not belong to the real native terminal turn'
  )
  await gates.wait('live-recovery')
  await gates.release('live-recovery')
  await gates.release('old-failed-history')
  const ordering = await gates.save(resultDir, 'overload-history-race.json', [
    'old-failed-history',
    'live-recovery',
  ])
  assert.ok(ordering['old-failed-history'].capturedAt < ordering['live-recovery'].deliveredAt)
  assert.ok(ordering['live-recovery'].deliveredAt < ordering['old-failed-history'].deliveredAt)
}
