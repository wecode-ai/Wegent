import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export const NATIVE_RECOVERY_TEXT = 'WEWORK_UNSENT_NATIVE_REPLY_MUST_SURVIVE'
const TAB = '[data-testid="workspace-tab-select-pending-interactions"]'
const TEXT = '[data-testid="interaction-unsent-text"]'

async function waitFor(read, ready, message) {
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (ready(last)) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`${message}: ${JSON.stringify(last)}`)
}

export async function pendingFixture(storagePath, question) {
  return waitFor(
    async () => {
      const { entries } = JSON.parse(await readFile(storagePath, 'utf8'))
      for (const [key, value] of Object.entries(entries)) {
        if (!key.startsWith('wework.interactions:') || !key.endsWith(':pending')) continue
        const item = JSON.parse(value).find(row => row.question === question)
        if (!item) continue
        return {
          accountKey: key.slice('wework.interactions:'.length, -':pending'.length),
          interactionId: JSON.stringify([
            item.address.deviceId,
            item.address.taskId,
            item.requestKey,
          ]),
          url: item.originalUrl,
        }
      }
      return null
    },
    Boolean,
    'The real pending question was not persisted'
  )
}

/** Reuse the existing turn, executor failure gate, host queue and actual disk store. */
export async function answerWithNativeReplyStorageFailure(
  control,
  { electronUserDataDirectory, question, submit, waitForTaskAnswer }
) {
  const storagePath = join(electronUserDataDirectory, 'renderer-local-storage.json')
  await control.command('flushRendererStorage', 'body')
  const fixture = await pendingFixture(storagePath, question)
  const readQueue = async () =>
    JSON.parse(
      await control.command('getNativeNotificationReplies', 'body', {
        value: fixture.accountKey,
      })
    )
  await control.command('holdLocalExecutorRequests', 'body', {
    value: JSON.stringify({ method: 'runtime.tasks.send', phase: 'before-dispatch' }),
  })
  const reply = JSON.parse(
    await control.command('enqueueNativeNotificationReply', 'body', {
      value: JSON.stringify({ ...fixture, text: NATIVE_RECOVERY_TEXT }),
    })
  )
  const backup = `${storagePath}.native-reply-recovery-${Date.now()}`
  let blocked = false
  let moved = false
  try {
    const nativeHold = JSON.parse(await control.command('awaitLocalExecutorRequestHold', 'body'))
    assert.equal(nativeHold.heldCount, 1, 'The native reply must be sending before the task answer')
    await control.command('failNextLocalExecutorRequest', 'body', {
      value: JSON.stringify({
        method: 'runtime.tasks.send',
        message: 'Native reply transport disconnected',
      }),
    })
    await submit()
    await waitFor(
      async () => JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body')),
      hold => hold?.heldCount === 2,
      'The real task answer did not overlap the native send'
    )
    await control.command('flushRendererStorage', 'body')
    await rename(storagePath, backup)
    moved = true
    await mkdir(storagePath)
    blocked = true
    assert.equal(await control.command('releaseLocalExecutorRequestHold', 'body'), 'true')
    await waitForTaskAnswer()
    await waitFor(
      async () => JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body')),
      hold => hold?.completedCount === 2,
      'The two concurrent sends did not finish'
    )
    // A real filesystem error, not a mocked rendererStorage success/failure response.
    await assert.rejects(
      () => control.command('flushRendererStorage', 'body'),
      /directory|EISDIR|EACCES|EPERM/i
    )
    assert.ok(
      (await readQueue()).some(row => row.id === reply.id),
      'Persistence failure acknowledged the only host copy'
    )
    assert.ok(
      !(await readFile(backup, 'utf8')).includes(reply.id),
      'The fixture did not exercise an uncommitted recovery record'
    )
  } finally {
    try {
      await control.command('releaseLocalExecutorRequestHold', 'body')
    } finally {
      if (blocked) await rmdir(storagePath)
      if (moved) await rename(backup, storagePath)
    }
  }
  await control.command('refreshRuntimeWork', 'body')
  await waitFor(
    readQueue,
    rows => rows.every(row => row.id !== reply.id),
    'Recovery never transferred ownership from the host'
  )
  await control.command('flushRendererStorage', 'body')
  const draftKey = `wework.interactions:${fixture.accountKey}:drafts`
  const { entries } = JSON.parse(await readFile(storagePath, 'utf8'))
  const saved = JSON.parse(entries[draftKey])[fixture.interactionId]
  assert.equal(saved.text, NATIVE_RECOVERY_TEXT)
  assert.equal(saved.interaction.question, question)
  assert.ok(
    saved.nativeReplyIds.includes(reply.id),
    'Recovery must persist the receipt with its text and metadata'
  )
  return { ...fixture, id: reply.id, storagePath, draftKey }
}

async function assertRecovered(control, recovery) {
  await control.command('clickWhenEnabled', TAB)
  await control.command('waitFor', '[data-testid="interactions-pending-count"]', {
    text: '0',
    visible: true,
  })
  await control.command('waitFor', TEXT, { visible: true })
  assert.equal(await control.command('getValue', TEXT), NATIVE_RECOVERY_TEXT)
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="interaction-list-item"]')),
    0
  )
  const queue = JSON.parse(
    await control.command('getNativeNotificationReplies', 'body', { value: recovery.accountKey })
  )
  assert.ok(
    queue.every(row => row.id !== recovery.id),
    'An acknowledged reply reappeared after reload'
  )
}

export async function verifyNativeReplyRecoveryAfterReload(control, recovery, restartDesktopApp) {
  await assertRecovered(control, recovery)
  // The host process is replaced; recovery must come from the real disk record.
  await restartDesktopApp()
  await assertRecovered(control, recovery)
  await control.command('click', '[data-testid="interaction-discard-unsent"]')
  await waitFor(
    () => control.command('getElementCount', TEXT),
    count => Number(count) === 0,
    'Discarding the unsent reply left its recovery entry visible'
  )
  await control.command('flushRendererStorage', 'body')
  const { entries } = JSON.parse(await readFile(recovery.storagePath, 'utf8'))
  assert.equal(JSON.parse(entries[recovery.draftKey])[recovery.interactionId], undefined)
  const ready = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await control.awaitReadyAfter(ready)
  await control.command('clickWhenEnabled', TAB)
  await control.command('waitFor', '[data-testid="interactions-pending-count"]', {
    text: '0',
    visible: true,
  })
  assert.equal(
    Number(await control.command('getElementCount', TEXT)),
    0,
    'Discarded recovery returned after reload'
  )
}
