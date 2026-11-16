import assert from 'node:assert/strict'
import { WORKBENCH_READY_TIMEOUT_MS, withTimeout } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const INPUT = `${ACTIVE} [data-testid="chat-message-input"]`

/** Open the same real task in two independent renderer service instances. */
export async function openReplyPredictionWindows(control, taskId) {
  const main = { command: (...args) => control.commandForWindow('main', ...args) }
  await main.command('contextMenu', '[data-testid="workspace-tab-select-fixed-task"]')
  const readyCount = control.readyCount
  await main.command('click', '[data-testid="workspace-tab-open-new-window"]')
  const ready = await withTimeout(
    control.awaitReadyAfter(readyCount),
    WORKBENCH_READY_TIMEOUT_MS,
    'The second reply-prediction renderer did not connect'
  )
  assert.ok(ready.windowLabel.startsWith('workspace-'))
  const detached = { command: (...args) => control.commandForWindow(ready.windowLabel, ...args) }
  await detached.command('waitFor', INPUT, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  const taskRow = `${ACTIVE} [data-testid="runtime-local-task-row-${taskId}"]`
  await detached.command('waitFor', taskRow)
  await detached.command('click', taskRow)
  await main.command('click', '[data-testid="workspace-tab-add"]')
  await main.command('click', '[data-testid="workspace-tab-add-task"]')
  await main.command('waitFor', taskRow)
  await main.command('click', taskRow)
  for (const window of [main, detached]) {
    await window.command('waitFor', `${ACTIVE} [data-testid="pause-response-button"]`)
    const snapshot = JSON.parse(await window.command('getWorkbenchDebugSnapshot', 'body'))
    assert.equal(snapshot.workbench.currentRuntimeTask.taskId, taskId)
    await window.command('fill', INPUT, { value: '' })
    assert.equal(await window.command('getValue', INPUT), '')
  }
  assert.equal(
    await detached.command('getLocationOrigin', 'body'),
    await main.command('getLocationOrigin', 'body')
  )
  return { main, detached, windowLabel: ready.windowLabel }
}

export async function waitForReplyPredictionContention(main, taskId, timeoutMs) {
  const locks = await waitForValue(
    async () => JSON.parse(await main.command('getWebLocksSnapshot', 'body')),
    snapshot =>
      snapshot.pending.some(
        lock => lock.name.startsWith('wework.replyPrediction:') && lock.name.includes(taskId)
      ),
    'The other renderer never waited on the same real prediction lock',
    timeoutMs
  )
  const held = locks.held.filter(
    lock => lock.name.startsWith('wework.replyPrediction:') && lock.name.includes(taskId)
  )
  assert.equal(held.length, 1)
  assert.ok(locks.pending.some(lock => lock.name === held[0].name))
  return { held: held[0].name, pending: locks.pending.length }
}
