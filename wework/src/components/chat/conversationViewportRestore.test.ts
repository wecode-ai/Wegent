import { afterEach, describe, expect, test } from 'vitest'
import {
  createScrollSnapshot,
  restoreConversationAnchor,
} from '../../../../packages/collaboration/src/conversation/conversationScrollGeometry'
import { clearConversationViewportCache } from '../../../../packages/collaboration/src/conversation/conversationViewportCache'

function readingViewport() {
  const scroller = document.createElement('div')
  Object.defineProperties(scroller, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 600 },
    scrollTop: { writable: true, value: 1000 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 100, 800, 600)
  scroller.innerHTML =
    '<article data-message-id="message"><div data-runtime-item-id="item"><p data-scroll-anchor></p></div></article>'
  const item = scroller.querySelector<HTMLElement>('[data-runtime-item-id]')!
  const paragraph = item.firstElementChild as HTMLElement
  item.getBoundingClientRect = paragraph.getBoundingClientRect = () => new DOMRect(0, 125, 700, 80)
  return scroller
}

describe('conversation viewport restoration', () => {
  afterEach(clearConversationViewportCache)

  test('does not move to a different item when the saved identity is absent', () => {
    const scroller = readingViewport()
    const snapshot = createScrollSnapshot(scroller)
    scroller.querySelector<HTMLElement>('[data-runtime-item-id]')!.dataset.runtimeItemId = 'other'
    expect(restoreConversationAnchor(scroller, snapshot)).toBe(false)
    expect(scroller.scrollTop).toBe(1000)
  })
})
