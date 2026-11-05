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
    measured('full-history', () =>
      readRuntimeTranscript({ address, includeFullContent: true }, params =>
        requestExecutor(control, 'runtime.tasks.transcript', params, timeoutMs)
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
  assert.ok(
    results[1].value.turns.flatMap(turn => turn.items).length >= LONG_HISTORY_ITEM_COUNT,
    'The concurrent full read must materialize the real long tool history'
  )
  for (const timing of timings.filter(timing => !timing.operation.endsWith('-history'))) {
    assert.ok(
      timing.elapsedMs < RESPONSIVENESS_TIMEOUT_MS,
      `${timing.operation} exceeded its responsiveness budget: ${timing.elapsedMs}ms`
    )
  }
}

async function browseIdleRunningHistory(control, taskId, cursor, scrolledCursors, clickedCursors) {
  if (!scrolledCursors.has(cursor)) {
    scrolledCursors.add(cursor)
    await control.command(
      'scrollToRatioAsUser',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`,
      { value: '0' }
    )
  }
  if (clickedCursors.has(cursor)) return
  const afterScroll = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const current = afterScroll.pane?.transcript
  if (
    afterScroll.workbench?.currentRuntimeTask?.taskId !== taskId ||
    afterScroll.pane?.currentRuntimeTask?.taskId !== taskId ||
    current?.beforeCursor !== cursor ||
    current.loading ||
    current.loadingMoreBefore ||
    !current.hasMoreBefore
  )
    return
  const older = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
  // A new automatic page may start after the snapshot. The existing atomic
  // action clicks only a currently present, enabled button and never waits.
  if ((await control.command('clickIfPresent', older)) === 'clicked') clickedCursors.add(cursor)
}

export async function restoreCompleteRunningHistory(control, taskId, timeoutMs) {
  await waitForRestoredTranscript(control, taskId, timeoutMs)
  const seenCursors = new Set()
  const scrolledCursors = new Set()
  const clickedCursors = new Set()
  let loadedItemCount = 0
  let lastProgressAt = Date.now()
  let performanceSnapshot
  await waitForTranscriptState(
    control,
    async snapshot => {
      assert.equal(snapshot.workbench?.currentRuntimeTask?.taskId, taskId)
      assert.equal(snapshot.pane?.currentRuntimeTask?.taskId, taskId)
      const transcript = snapshot.pane.transcript
      performanceSnapshot = JSON.parse(
        await control.command('performanceSnapshot', 'body', {
          value: JSON.stringify({ collectMemory: false }),
          timeoutMs: RESPONSIVENESS_TIMEOUT_MS,
        })
      )
      const count = performanceSnapshot.runtimeAssistantDisplayItemCount
      const cursor = transcript.beforeCursor
      // Collapsed tool groups can keep the boundary visible across consecutive
      // automatic pages. Progress does not require an observable idle gap.
      if (count > loadedItemCount || (cursor && !seenCursors.has(cursor))) {
        lastProgressAt = Date.now()
      }
      loadedItemCount = Math.max(loadedItemCount, count)
      if (cursor) seenCursors.add(cursor)
      assert.ok(
        Date.now() - lastProgressAt < timeoutMs,
        `Loading older history made no progress: ${JSON.stringify({ count, ...transcript })}`
      )
      if (transcript.loading || transcript.loadingMoreBefore) return false
      assert.equal(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-transcript-error"]`
        ),
        '0',
        'Loading older history reported a transcript error'
      )
      if (!transcript.hasMoreBefore) {
        assert.ok(
          count >= LONG_HISTORY_ITEM_COUNT,
          'Pagination ended before restoring the complete long tool history'
        )
        assert.equal(cursor, null, 'Completed history retained an older page cursor')
        return true
      }
      await browseIdleRunningHistory(control, taskId, cursor, scrolledCursors, clickedCursors)
      return false
    },
    'The long tool history never finished paging',
    WORKBENCH_READY_TIMEOUT_MS
  )
  return performanceSnapshot
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
