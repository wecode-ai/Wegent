import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readRuntimeTranscript } from '../../../../packages/chat-core/src/runtime-transcript-transport.ts'
import { requestExecutor } from './executor-rpc.mjs'
import { currentExecutorPid, waitForRestartedExecutor } from './executor-restart-readiness.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { ACTIVE_WORKBENCH_SELECTOR } from './shared.mjs'
import { waitForTranscriptState } from './transcript-restoration.mjs'

export async function verifyRuntimeReceiptRecovery(
  control,
  { address, prompt, completion, resultDir, timeoutMs }
) {
  const gates = runtimeTransportGates(control)
  const send = 'recovery-undispatched-send'
  const lagged = 'recovery-real-history-loss'
  const receipt = 'recovery-empty-receipt'
  const goal = 'recovery-goal-after-receipt'
  await gates.arm({
    id: send,
    kind: 'request',
    name: 'runtime.tasks.send',
    where: [{ path: 'params.taskId', equals: address.taskId }],
  })
  try {
    await control.command(
      'fill',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`,
      {
        value: prompt,
      }
    )
    await control.command(
      'press',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`,
      {
        key: 'Enter',
      }
    )
    const pending = await gates.wait(send, undefined, timeoutMs)
    const messageId = pending.value.params.executionRequest.client_user_message_id
    assert.ok(messageId, 'The real UI send must have a client message identity')
    assert.equal(pending.value.params.commandId, undefined)
    await waitForTranscriptState(
      control,
      snapshot =>
        snapshot.pane?.queuedMessages.some(row => row.id === messageId && row.status === 'sending'),
      'The undispatched UI send did not remain pending',
      timeoutMs
    )
    await gates.arm({
      id: lagged,
      kind: 'event',
      name: 'executor.event_lagged',
      where: [{ path: 'payload.reason', equals: 'event_history_lost' }],
      hold: false,
    })
    await gates.arm({
      id: receipt,
      kind: 'response',
      name: 'runtime.tasks.transcript',
      where: [
        { path: 'params.taskId', equals: address.taskId },
        { path: 'params.reconcileClientUserMessageIds.*', equals: messageId },
      ],
    })
    const executorLogPath = join(resultDir, 'executor.log')
    const logOffset = (await readFile(executorLogPath, 'utf8')).length
    const originalPid = await currentExecutorPid(control)
    assert.ok(originalPid, 'Receipt recovery needs the real running executor')
    process.kill(originalPid, 'SIGTERM')
    const restartedPid = await waitForRestartedExecutor({
      control,
      originalPid,
      executorLogPath,
      logOffset,
      timeoutMs,
    })
    const recovery = await gates.wait(lagged, undefined, timeoutMs)
    const confirmation = await gates.wait(receipt, undefined, timeoutMs)
    assert.deepEqual(confirmation.value.result.acceptedClientUserMessageIds, [])
    await gates.arm({
      id: goal,
      kind: 'response',
      name: 'runtime.tasks.goal.get',
      where: [{ path: 'params.taskId', equals: address.taskId }],
    })
    const receiptAppliedAfter = Date.now()
    await gates.release(receipt)
    // Goal reconciliation follows application of the actual receipt response.
    await gates.wait(goal, undefined, timeoutMs)
    const reconciled = await waitForTranscriptState(
      control,
      snapshot =>
        Date.parse(snapshot.pane?.updatedAt) >= receiptAppliedAfter &&
        snapshot.pane?.queuedMessages.some(row => row.id === messageId && row.status === 'sending'),
      'An empty receipt must keep the pending send unconfirmed',
      timeoutMs
    )
    assert.equal((await gates.read(send)).deliveries, 0, 'The fixture must remain undispatched')
    await writeFile(
      join(resultDir, 'runtime-receipt-recovery.json'),
      JSON.stringify(
        {
          originalPid,
          restartedPid,
          reason: recovery.value.payload.reason,
          messageId,
          acceptedClientUserMessageIds: [],
          pendingStatus: reconciled.pane.queuedMessages.find(row => row.id === messageId).status,
          sendDispatchedAtReconciliation: false,
        },
        null,
        2
      )
    )
    await gates.release(goal)
    await gates.release(send)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: completion,
      timeoutMs,
    })
    await waitForTranscriptState(
      control,
      snapshot => !snapshot.pane?.queuedMessages.some(row => row.id === messageId),
      'The released original send was not acknowledged',
      timeoutMs
    )
    const accepted = await readRuntimeTranscript(
      { address, limit: 5, reconcileClientUserMessageIds: [messageId] },
      params => requestExecutor(control, 'runtime.tasks.transcript', params, timeoutMs)
    )
    assert.deepEqual(accepted.acceptedClientUserMessageIds, [messageId])
    assert.equal(
      accepted.turns.filter(turn =>
        turn.items.some(
          item => item.type === 'user_message' && item.message.clientUserMessageId === messageId
        )
      ).length,
      1
    )
  } finally {
    await gates.reset()
  }
}
