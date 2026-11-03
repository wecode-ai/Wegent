import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readRuntimeTranscript } from '../../../../packages/chat-core/src/runtime-transcript-transport.ts'
import { requestExecutor } from './executor-rpc.mjs'
import { LONG_HISTORY_ITEM_COUNT } from './running-history-fixtures.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { waitForRestoredTranscript, waitForTranscriptState } from './transcript-restoration.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'

const RESPONSIVENESS_TIMEOUT_MS = 3_000

export async function verifyHistoryReadResponsiveness(
  control,
  address,
  resultDir,
  timeoutMs,
  executorHome
) {
  await waitForRestoredTranscript(control, address.taskId, timeoutMs)
  const index = JSON.parse(await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8'))
  const task = Object.values(index.tasks ?? {}).find(task => task.local_task_id === address.taskId)
  const accepted = task?.runtime_handle?.userMessagePresentations?.findLast(
    presentation => presentation.turnId && presentation.clientUserMessageId
  )?.clientUserMessageId
  assert.ok(accepted, 'The real long-history prompt has no bound acceptance identity')
  const unaccepted = 'wework-e2e-unaccepted-recovery-message'
  const timings = []
  const measured = async (operation, run) => {
    const startedAt = performance.now()
    try {
      const result = await run()
      timings.push({ operation, elapsedMs: Math.round(performance.now() - startedAt), ok: true })
      return result
    } catch (error) {
      timings.push({ operation, elapsedMs: Math.round(performance.now() - startedAt), ok: false })
      throw error
    }
  }
  // Run the real versioned transcript transfer beside real control requests.
  // The shared controller keeps polling while fetchLocalRuntime requests overlap.
  const results = await Promise.allSettled([
    measured('paged-history', () =>
      readRuntimeTranscript(
        { address, limit: 5, reconcileClientUserMessageIds: [accepted, unaccepted] },
        params => requestExecutor(control, 'runtime.tasks.transcript', params, timeoutMs)
      )
    ),
    ...[
      ['executor.health', {}],
      ['runtime.tasks.get', { address }],
      ['runtime.tasks.list', { preferCached: true }],
    ].map(([method, params]) =>
      measured(method, () => requestExecutor(control, method, params, RESPONSIVENESS_TIMEOUT_MS))
    ),
    measured('renderer', () =>
      control.command('getWorkbenchDebugSnapshot', 'body', {
        timeoutMs: RESPONSIVENESS_TIMEOUT_MS,
      })
    ),
  ])
  await writeFile(
    join(resultDir, 'running-history-responsiveness.json'),
    JSON.stringify({ timings }, null, 2)
  )
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) {
    throw new AggregateError(
      failures.map(result => result.reason),
      'History reads must not block control requests or the renderer'
    )
  }
  const history = results[0].value
  assert.equal(history.hasMoreBefore, true, 'The default history page must retain an older cursor')
  assert.ok(history.beforeCursor, 'The normal history page must identify its next older page')
  assert.ok(
    history.turns.flatMap(turn => turn.items).length < LONG_HISTORY_ITEM_COUNT,
    'A normal page must not materialize the entire long turn'
  )
  assert.ok(
    history.turns.every(turn => turn.items.every(item => item.type !== 'user_message')),
    'The receipt fixture must keep the accepted prompt outside the loaded tail'
  )
  assert.deepEqual(
    history.acceptedClientUserMessageIds,
    [accepted],
    'A bounded tail must confirm off-page acceptance without inventing an unaccepted send'
  )
  for (const timing of timings.filter(timing => timing.operation !== 'paged-history')) {
    assert.ok(
      timing.elapsedMs < RESPONSIVENESS_TIMEOUT_MS,
      `${timing.operation} exceeded its responsiveness budget: ${timing.elapsedMs}ms`
    )
  }
}

export async function restoreCompleteRunningHistory(control, taskId, timeoutMs) {
  await waitForRestoredTranscript(control, taskId, timeoutMs)
  const older = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
  const deadline = Date.now() + WORKBENCH_READY_TIMEOUT_MS
  for (let page = 0; page < LONG_HISTORY_ITEM_COUNT && Date.now() < deadline; page += 1) {
    const performanceSnapshot = JSON.parse(
      await control.command('performanceSnapshot', 'body', {
        value: JSON.stringify({ collectMemory: false }),
        timeoutMs: RESPONSIVENESS_TIMEOUT_MS,
      })
    )
    if (performanceSnapshot.runtimeAssistantDisplayItemCount >= LONG_HISTORY_ITEM_COUNT) {
      return performanceSnapshot
    }
    const before = await waitForTranscriptState(
      control,
      snapshot =>
        snapshot.pane?.currentRuntimeTask?.taskId === taskId &&
        snapshot.pane.transcript.loading === false &&
        snapshot.pane.transcript.loadingMoreBefore === false,
      'The older long-history page did not settle',
      timeoutMs
    )
    assert.equal(
      before.pane.transcript.hasMoreBefore,
      true,
      'Pagination ended before restoring the complete long tool history'
    )
    await control.command('scrollIntoView', older)
    const afterScroll = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (
      afterScroll.pane.transcript.hasMoreBefore &&
      !afterScroll.pane.transcript.loadingMoreBefore
    ) {
      await control.command('clickWhenEnabled', older)
    }
    let loadedItemCount = performanceSnapshot.runtimeAssistantDisplayItemCount
    await waitForTranscriptState(
      control,
      snapshot =>
        snapshot.pane?.transcript?.loadingMoreBefore === false &&
        loadedItemCount > performanceSnapshot.runtimeAssistantDisplayItemCount,
      'Loading older history did not restore additional real tool items',
      timeoutMs,
      async () => {
        const performance = JSON.parse(
          await control.command('performanceSnapshot', 'body', {
            value: JSON.stringify({ collectMemory: false }),
            timeoutMs: RESPONSIVENESS_TIMEOUT_MS,
          })
        )
        loadedItemCount = performance.runtimeAssistantDisplayItemCount
      }
    )
  }
  assert.fail('The long tool history never finished paging')
}

export async function verifyTerminalHistoryRefresh(
  control,
  { taskId, completion, release, timeoutMs, resultDir }
) {
  const gates = runtimeTransportGates(control)
  const full = 'terminal-full-history-request'
  const observed = 'terminal-history-request'
  await gates.arm({
    id: full,
    kind: 'request',
    name: 'runtime.tasks.transcript',
    where: [
      { path: 'params.taskId', equals: taskId },
      { path: 'params.includeFullContent', equals: true },
    ],
    hold: false,
  })
  await gates.arm({
    id: observed,
    kind: 'request',
    name: 'runtime.tasks.transcript',
    where: [{ path: 'params.taskId', equals: taskId }],
    hold: false,
  })
  try {
    release()
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: completion,
      timeoutMs,
    })
    await waitForTranscriptState(
      control,
      snapshot =>
        snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
        snapshot.workbench.runningState.activeTaskRunning === false &&
        snapshot.pane?.transcript?.loading === false,
      'The completed long-history task did not settle',
      timeoutMs
    )
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes('thinking-indicator'),
      'The completed long-history task kept its thinking indicator',
      timeoutMs
    )
    const startedAt = Date.now()
    // Observe the actual request boundary for a negative window; a slow full
    // response must not hide a full-history request that was already started.
    await waitForTranscriptState(
      control,
      () => Date.now() - startedAt >= RESPONSIVENESS_TIMEOUT_MS,
      'The terminal history observation window did not finish',
      timeoutMs,
      async () => {
        assert.equal(await gates.read(full), null, 'Turn completion started a full-history scan')
        const capture = await gates.read(observed)
        if (capture) {
          assert.notEqual(capture.value.params.includeFullContent, true)
          assert.ok(
            Number.isSafeInteger(capture.value.params.limit) && capture.value.params.limit <= 20,
            'Terminal history repair must keep a bounded page limit'
          )
        }
      }
    )
    await gates.save(resultDir, 'running-history-terminal-requests.json', [full, observed])
  } finally {
    await gates.reset()
  }
}
