import { afterEach, expect, test, vi } from 'vitest'
import {
  createScrollSnapshot,
  restoreConversationAnchor,
} from '../../../../packages/collaboration/src/conversation/conversationScrollGeometry'

const caretDescriptor = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  if (caretDescriptor) Object.defineProperty(document, 'caretRangeFromPoint', caretDescriptor)
  else Reflect.deleteProperty(document, 'caretRangeFromPoint')
})

test.each([
  [true, false],
  [false, false],
  [true, true],
  [false, true],
])(
  'restores the same paragraph after earlier Markdown chunks change representation (runtime item: %s, appends while away: %s)',
  (runtimeItem, appends) => {
    const scroller = document.createElement('div')
    scroller.innerHTML = `<article data-message-id="message"><div ${runtimeItem ? 'data-runtime-item-id="item"' : ''}><div data-markdown-chunk-index="0"><p data-scroll-anchor>prefix</p></div><div data-markdown-chunk-index="1"><p data-scroll-anchor>Reading the same paragraph</p></div></div></article>`
    document.body.append(scroller)
    Object.defineProperties(scroller, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 2000 },
      scrollTop: { value: 500, writable: true },
    })
    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 600, 200)
    const reader = () => scroller.querySelector<HTMLElement>('[data-markdown-chunk-index="1"] p')!
    const bounds = () => {
      for (const root of scroller.querySelectorAll<HTMLElement>(
        '[data-message-id], [data-runtime-item-id]'
      ))
        root.getBoundingClientRect = () => new DOMRect(0, -400, 600, 2000)
      reader().getBoundingClientRect = () => new DOMRect(0, 620 - scroller.scrollTop, 600, 24)
      scroller.querySelector<HTMLElement>(
        '[data-markdown-chunk-index="0"]'
      )!.getBoundingClientRect = () => new DOMRect(0, -600, 600, 120)
      const prefix = scroller.querySelector<HTMLElement>('[data-markdown-chunk-index="0"] p')
      if (prefix) prefix.getBoundingClientRect = () => new DOMRect(0, -600, 600, 24)
    }
    bounds()
    const createRange = document.createRange.bind(document)
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange()
      range.getClientRects = () =>
        [range.startContainer.parentElement!.getBoundingClientRect()] as unknown as DOMRectList
      return range
    })
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const range = document.createRange()
        range.setStart(reader().firstChild!, 4)
        range.setEnd(reader().firstChild!, 5)
        return range
      },
    })
    const snapshot = createScrollSnapshot(scroller)
    const restored = scroller.firstElementChild!.cloneNode(true) as HTMLElement
    restored.querySelector('[data-markdown-chunk-index="0"]')!.textContent =
      '# **A raw Markdown placeholder has different characters from rendered markup.**'
    if (appends)
      restored.querySelector('[data-markdown-chunk-index="1"] p')!.textContent +=
        ' More text streamed while this task was inactive.'
    scroller.replaceChildren(restored)
    bounds()

    expect(restoreConversationAnchor(scroller, snapshot)).toBe(true)
    expect(scroller.scrollTop).toBe(500)
    expect(reader().getBoundingClientRect().top).toBe(120)
  }
)
