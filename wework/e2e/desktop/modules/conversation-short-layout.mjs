import assert from 'node:assert/strict'
import { SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET } from './shared.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, getSingleElementMetrics } from './streaming-text-fixture.mjs'

export async function verifyShortConversationTopAlignment(control, description) {
  const viewport = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
    `${description}: viewport`
  )
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
