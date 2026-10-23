import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'
import {
  cacheConversationScrollSnapshot,
  clearConversationViewportCache,
  getConversationScrollSnapshot,
} from '../../../../packages/collaboration/src/conversation/conversationViewportCache'
import {
  createScrollSnapshot,
  restoreConversationAnchor,
} from '../../../../packages/collaboration/src/conversation/conversationScrollGeometry'

function readingViewport() {
  const scroller = document.createElement('div')
  Object.defineProperties(scroller, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 600 },
    scrollTop: { writable: true, value: -400 },
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

  test.each([true, false])(
    'retains the reading anchor on immediate unmount after restore=%s',
    restore => {
      const scroller = readingViewport()
      const snapshot = createScrollSnapshot(scroller, true)
      const key = `immediate-switch-${restore}`
      cacheConversationScrollSnapshot(key, snapshot)
      const hook = renderHook(() =>
        useConversationScrollController({
          messages: [
            { id: 'message', role: 'assistant', content: 'Reading', status: 'done', createdAt: '' },
          ],
          externalScrollRef: { current: scroller },
          conversationKey: key,
        })
      )
      if (restore) act(() => hook.result.current.restoreSavedScrollPosition(key, snapshot))
      hook.unmount()
      expect(getConversationScrollSnapshot(key)?.anchor).toEqual(snapshot.anchor)
    }
  )
  test('restores the same runtime item after remount and preceding items change', () => {
    const original = readingViewport()
    const snapshot = createScrollSnapshot(original, true)
    expect(snapshot.anchor).toEqual({
      messageId: 'message',
      itemId: 'item',
      textOffset: null,
      offsetFromScrollerTop: 25,
    })
    const remounted = readingViewport()
    const item = remounted.querySelector<HTMLElement>('[data-runtime-item-id]')!
    item.getBoundingClientRect = () => new DOMRect(0, 325, 700, 80)
    item.before(document.createElement('div'))
    expect(restoreConversationAnchor(remounted, snapshot)).toBe(true)
    expect(remounted.scrollTop).toBe(-200)
    expect(original.scrollTop).toBe(-400)
  })

  test('does not move to a different item when the saved identity is absent', () => {
    const scroller = readingViewport()
    const snapshot = createScrollSnapshot(scroller, true)
    scroller.querySelector<HTMLElement>('[data-runtime-item-id]')!.dataset.runtimeItemId = 'other'
    expect(restoreConversationAnchor(scroller, snapshot)).toBe(false)
    expect(scroller.scrollTop).toBe(-400)
  })

  test('does not read DOM anchor geometry while following the bottom', () => {
    const scroller = readingViewport()
    scroller.scrollTop = 0
    const geometry = vi.spyOn(scroller, 'getBoundingClientRect')
    const snapshot = createScrollSnapshot(scroller, true)
    expect(snapshot.pinnedToBottom).toBe(true)
    expect(snapshot.anchor).toBeUndefined()
    expect(geometry).not.toHaveBeenCalled()
    expect(restoreConversationAnchor(scroller, snapshot)).toBe(false)
  })
})
