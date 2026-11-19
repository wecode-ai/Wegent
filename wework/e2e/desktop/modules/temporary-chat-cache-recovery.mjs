import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CACHE_IDLE_TTL_MS = 300_000

async function readCachedMessages(control, address) {
  return JSON.parse(
    await control.command('getRuntimeConversationMessages', 'body', {
      value: JSON.stringify(address),
    })
  )
}

export async function assertTemporaryChatMessages(
  control,
  { address, expectedMessages, sideChatSelector, forbiddenTexts = [], requireAllRendered = true }
) {
  const messages = await readCachedMessages(control, address)
  assert.deepEqual(
    messages.map(({ role, content }) => ({ role, content })),
    expectedMessages,
    'The temporary chat cache changed message content, order, or count'
  )
  assert.equal(new Set(messages.map(message => message.id)).size, messages.length)
  const renderedMessages = []
  for (const message of messages) {
    const row = `${sideChatSelector} [data-message-id=${JSON.stringify(message.id)}]`
    const count = Number(await control.command('getElementCount', row))
    assert.ok(count === 0 || count === 1, 'The temporary chat rendered duplicate message rows')
    if (requireAllRendered)
      assert.equal(count, 1, 'The temporary chat did not render every message')
    if (count === 0) continue
    renderedMessages.push(message)
    assert.equal(
      await control.command('getAttribute', row, { value: 'data-testid' }),
      `message-${message.role}`,
      'A rendered temporary chat message has the wrong role'
    )
  }
  assert.ok(renderedMessages.length > 0, 'The temporary chat did not render any messages')
  assert.equal(
    Number(await control.command('getElementCount', `${sideChatSelector} [data-message-id]`)),
    renderedMessages.length,
    'The temporary chat rendered unknown or duplicate message rows'
  )
  const contentSelector = ['user-message-content', 'assistant-message-content']
    .map(testId => `${sideChatSelector} [data-testid="${testId}"]`)
    .join(', ')
  const domText = await control.command('getText', contentSelector)
  // getText joins matching elements in document order with one newline.
  assert.equal(domText, renderedMessages.map(message => message.content.trim()).join('\n'))
  const panelText = await control.command('getText', sideChatSelector)
  const cachedText = messages.map(message => message.content).join('\n')
  for (const text of forbiddenTexts) {
    assert.ok(!cachedText.includes(text), `The temporary chat cache contains main content: ${text}`)
    assert.ok(!panelText.includes(text), `The temporary chat rendered main content: ${text}`)
  }
  return {
    messages: messages.map(({ id, role, content }) => ({ id, role, content })),
    renderedMessageIds: renderedMessages.map(message => message.id),
    domText,
  }
}

async function waitForPanelUnmount(control, selector, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (Number(await control.command('getElementCount', selector)) === 0) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('Switching main tasks kept the temporary chat panel mounted')
}

async function waitForRealCacheEviction(control, address, startedAt, timeoutMs) {
  let nextProgressAt = 30_000
  while (performance.now() - startedAt < CACHE_IDLE_TTL_MS + timeoutMs) {
    const messages = await readCachedMessages(control, address)
    const elapsedMs = performance.now() - startedAt
    if (messages.length === 0) {
      assert.ok(
        elapsedMs >= CACHE_IDLE_TTL_MS,
        'The temporary chat cache expired before five minutes'
      )
      return { elapsedMs, observedAt: new Date().toISOString(), messages }
    }
    if (elapsedMs >= nextProgressAt) {
      console.log(
        `[temporary-chat] Waiting for real cache eviction: ${Math.floor(elapsedMs / 1000)}s`
      )
      nextProgressAt += 30_000
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.fail('The unmounted temporary chat cache did not expire after its real five-minute TTL')
}

export async function verifyTemporaryChatCacheRecovery(control, options) {
  const {
    address,
    sourceTaskRow,
    expectedMessages,
    sideChatSelector,
    mainComposerSelector,
    uiTimeoutMs,
    resultDir,
  } = options
  assert.ok(address?.deviceId && address.taskId, 'Cache recovery requires the side task address')
  assert.ok(expectedMessages.length > 0, 'Cache recovery requires completed side messages')
  const evidence = { address, expectedMessages, startedAt: new Date().toISOString() }
  try {
    evidence.before = await assertTemporaryChatMessages(control, options)
    const startedAt = performance.now()
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', mainComposerSelector, { timeoutMs: uiTimeoutMs })
    await waitForPanelUnmount(control, sideChatSelector, uiTimeoutMs)
    evidence.afterUnmount = await readCachedMessages(control, address)
    assert.deepEqual(
      evidence.afterUnmount.map(({ role, content }) => ({ role, content })),
      expectedMessages,
      'Unmounting the temporary chat cleared its cache before the idle TTL'
    )
    evidence.eviction = await waitForRealCacheEviction(control, address, startedAt, uiTimeoutMs)
    await control.command('click', `[data-testid=${JSON.stringify(sourceTaskRow)}]`)
    await control.command('waitFor', sideChatSelector, {
      text: expectedMessages.at(-1).content.trim(),
      timeoutMs: uiTimeoutMs,
    })
    evidence.restored = await assertTemporaryChatMessages(control, options)
    evidence.completedAt = new Date().toISOString()
    return evidence
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await writeFile(
      join(resultDir, 'temporary-chat-cache-recovery.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8'
    )
  }
}
