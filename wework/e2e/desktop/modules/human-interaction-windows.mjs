import assert from 'node:assert/strict'
import { WORKBENCH_READY_TIMEOUT_MS, withTimeout } from './shared.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'

/** Two real, same-session windows must not submit the same decision twice. */
export async function verifyHumanInteractionAcrossWindows({
  control,
  page,
  question,
  answer,
  captureScreenshot,
}) {
  const originalTab = '[data-testid="workspace-tab-select-fixed-task"]'
  await control.command('contextMenu', originalTab)
  const readyCount = control.readyCount
  await control.command('click', '[data-testid="workspace-tab-open-new-window"]')
  const ready = await withTimeout(
    control.awaitReadyAfter(readyCount),
    WORKBENCH_READY_TIMEOUT_MS,
    'The second human-interaction window did not connect'
  )
  assert.ok(ready.windowLabel.startsWith('workspace-'))
  const detached = { command: (...args) => control.commandForWindow(ready.windowLabel, ...args) }
  await detached.command('waitFor', '[data-testid="wework-notifications-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await detached.command('click', '[data-testid="wework-notifications-button"]')
  await detached.command('waitFor', '[data-testid="wework-notifications-pending"]', {
    text: question,
  })
  await detached.command('click', '[data-testid="wework-notifications-pending"]')
  await detached.command('waitFor', page, { text: question })
  await detached.command(
    'waitFor',
    `${page} [data-testid="interaction-reply-input"]:not(:disabled)`,
    { visible: true }
  )
  await detached.command('fill', `${page} [data-testid="interaction-reply-input"]`, {
    value: answer,
  })
  const main = { command: (...args) => control.commandForWindow('main', ...args) }
  assert.equal(
    await detached.command('getLocationOrigin', 'body'),
    await main.command('getLocationOrigin', 'body')
  )
  await captureScreenshot(detached, '06a-second-window-pending.png')
  const gates = runtimeTransportGates(main)
  await gates.arm({
    id: 'human-window-revalidation',
    kind: 'response',
    name: 'runtime.tasks.transcript',
    hold: true,
    holdFollowing: true,
  })
  try {
    await main.command('click', `${page} [data-testid="interaction-reply-send"]`)
    await gates.wait('human-window-revalidation')
    const first = JSON.parse(await main.command('getWebLocksSnapshot', 'body'))
    const requestLock = first.held.find(lock => lock.name.includes(':history:'))
    assert.ok(requestLock, 'The first renderer must hold the request lock during revalidation')
    await detached.command('click', `${page} [data-testid="interaction-reply-send"]`)
    await detached.command('waitFor', `${page} [data-testid="interaction-reply-send"]:disabled`)
    const second = JSON.parse(await detached.command('getWebLocksSnapshot', 'body'))
    assert.ok(
      second.pending.some(lock => lock.name === requestLock.name),
      'The second renderer must wait on the same real browser lock'
    )
    assert.equal(second.held.filter(lock => lock.name === requestLock.name).length, 1)
    await captureScreenshot(detached, '06b-second-window-waits-for-owner.png')
  } finally {
    await gates.reset()
  }
  await detached.command('waitFor', `${page} [data-testid="interactions-pending-count"]`, {
    text: '0',
  })
  await captureScreenshot(detached, '06c-second-window-observes-accepted-reply.png')
  control.activateWindow('main')
  await main.command('focusMainWindow', 'body')
}
