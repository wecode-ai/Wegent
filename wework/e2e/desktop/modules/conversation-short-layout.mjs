import assert from 'node:assert/strict'
import { DEFAULT_STEP_TIMEOUT_MS, SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET } from './shared.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, getSingleElementMetrics } from './streaming-text-fixture.mjs'

export async function verifyShortConversationTopAlignment(control, description) {
  await withShortConversationViewport(control, description, viewport =>
    assertShortConversationTopAlignment(control, description, viewport)
  )
}

export async function withShortConversationViewport(control, description, verify) {
  const previousWindowSize = JSON.parse(
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 1280, height: 1200 }),
    })
  )
  try {
    const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
    let viewport
    do {
      viewport = await getSingleElementMetrics(
        control,
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
        `${description}: resized viewport`
      )
      if (viewport.clientHeight >= 1000 && viewport.scrollHeight <= viewport.clientHeight) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    assert.ok(viewport.clientHeight >= 1000, `${description}: the tall viewport did not resize`)
    assert.ok(
      viewport.scrollHeight <= viewport.clientHeight,
      `${description}: the short-conversation fixture overflows (${viewport.scrollHeight}px / ${viewport.clientHeight}px)`
    )
    await verify(viewport)
  } finally {
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify(previousWindowSize),
    })
  }
}

async function assertShortConversationTopAlignment(control, description, viewport) {
  const messages = JSON.parse(
    await control.command(
      'getElementMetrics',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"] [data-message-id]`
    )
  )
  assert.equal(messages.length, 4, `${description}: expected two complete conversation turns`)
  const offset = messages[0].top - viewport.top
  assert.ok(
    offset >= 0 && offset <= SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET,
    `${description}: the first message is ${offset}px from the viewport top`
  )
  const footer = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-sticky-footer"]`,
    `${description}: sticky composer`
  )
  assert.ok(
    messages.at(-1).bottom <= footer.top + 2,
    `${description}: short-conversation messages overlap the composer`
  )
}
