import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createUserViewportAnchor,
  findUserViewportAnchor,
  getTextOffsetRect,
} from '../../../../packages/collaboration/src/conversation/conversationScrollGeometry'
import { ScrollableMessageArea } from './ScrollableMessageArea'

let virtualLayoutCallback: (() => void) | undefined
let conversationIndex = 0

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => true,
}))

vi.mock('../../../../packages/collaboration/src/conversation/MessageList', () => ({
  MessageList: ({ onVirtualLayoutChange }: { onVirtualLayoutChange?: () => void }) => {
    virtualLayoutCallback = onVirtualLayoutChange
    return (
      <article data-message-id="message">
        <div data-testid="earlier-windowed-chunk" data-markdown-window-chunk />
        <p data-testid="reading-anchor" data-scroll-anchor>
          The reader's current paragraph
        </p>
        <div data-testid="later-anchors" />
      </article>
    )
  },
}))

function semanticAnchor(top: number) {
  const element = document.createElement('p')
  element.dataset.scrollAnchor = ''
  element.textContent = 'Another paragraph'
  element.getBoundingClientRect = () => new DOMRect(0, top, 736, 24)
  return element
}

function renderPausedReader(prefixCount = 0) {
  render(
    <ScrollableMessageArea
      conversationKey={`anchor-identity-${conversationIndex++}`}
      scrollOrigin="bottom"
      messages={[
        { id: 'message', role: 'assistant', content: 'Text', status: 'done', createdAt: '' },
      ]}
    />
  )
  const scroller = screen.getByTestId('chat-message-scroll-area')
  const reader = screen.getByTestId('reading-anchor')
  const earlierChunk = screen.getByTestId('earlier-windowed-chunk')
  const laterAnchors = screen.getByTestId('later-anchors')
  const initialScrollTop = -9_583
  let scrollHeight = 13_372
  let readerLayoutShift = 0
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 791 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: { configurable: true, writable: true, value: initialScrollTop },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 100, 1_200, 791)
  reader.getBoundingClientRect = () =>
    new DOMRect(0, 104.75 + readerLayoutShift - (scroller.scrollTop - initialScrollTop), 736, 24)
  earlierChunk.replaceChildren(...Array.from({ length: prefixCount }, () => semanticAnchor(-1_500)))
  laterAnchors.replaceChildren(semanticAnchor(500), semanticAnchor(600))
  act(() => virtualLayoutCallback?.())
  fireEvent.wheel(scroller, { deltaY: -56 })
  fireEvent.scroll(scroller)
  const sampled = createUserViewportAnchor(scroller, scroller)!
  expect(sampled.element).toBe(reader)
  expect(scroller.scrollTop).toBe(initialScrollTop)
  return {
    scroller,
    reader,
    earlierChunk,
    sampled,
    setHeight: (height: number) => {
      scrollHeight = height
    },
    setReaderLayoutShift: (shift: number) => {
      readerLayoutShift = shift
    },
  }
}

describe('ScrollableMessageArea anchor node identity', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    virtualLayoutCallback = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test.each([
    { heightDelta: 56, wrongOffset: -1_200.41, wrongCorrection: -1_205.16 },
    { heightDelta: -20, wrongOffset: -436.41, wrongCorrection: -441.16 },
  ])(
    'keeps the reading node when a preceding chunk renders with a $heightDelta px height delta',
    ({ heightDelta, wrongOffset, wrongCorrection }) => {
      const { scroller, reader, earlierChunk, sampled, setHeight } = renderPausedReader()
      const scrollTop = scroller.scrollTop
      const top = reader.getBoundingClientRect().top
      earlierChunk.replaceChildren(semanticAnchor(100 + wrongOffset))
      setHeight(scroller.scrollHeight + heightDelta)

      // The message-wide ordinal now resolves to a different paragraph, reproducing the live jumps.
      const ordinalAnchor =
        scroller.querySelectorAll<HTMLElement>('[data-scroll-anchor]')[sampled.anchorIndex]!
      expect(ordinalAnchor).not.toBe(reader)
      expect(
        ordinalAnchor.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          sampled.offsetFromScrollerTop
      ).toBeCloseTo(wrongCorrection)
      expect(findUserViewportAnchor(scroller, sampled)).toBe(reader)
      act(() => virtualLayoutCallback!())

      expect(scroller.scrollTop).toBe(scrollTop)
      expect(reader.getBoundingClientRect().top).toBe(top)
    }
  )

  test('keeps the reading node after preceding semantic anchors are removed', () => {
    const { scroller, reader, earlierChunk, sampled } = renderPausedReader(2)
    const scrollTop = scroller.scrollTop
    earlierChunk.replaceChildren()
    expect(scroller.querySelectorAll('[data-scroll-anchor]')[sampled.anchorIndex]).not.toBe(reader)

    expect(findUserViewportAnchor(scroller, sampled)).toBe(reader)
    act(() => virtualLayoutCallback!())

    expect(scroller.scrollTop).toBe(scrollTop)
  })

  test('continues correcting the original node when layout moves it', () => {
    const { scroller, reader, setReaderLayoutShift } = renderPausedReader()
    const top = reader.getBoundingClientRect().top
    setReaderLayoutShift(-40)
    act(() => virtualLayoutCallback!())

    expect(scroller.scrollTop).toBe(-9_623)
    expect(reader.getBoundingClientRect().top).toBe(top)
  })

  test('preserves the sampled text offset when preceding anchors change', () => {
    const { scroller, reader, earlierChunk, setReaderLayoutShift } = renderPausedReader(1)
    const createRange = document.createRange.bind(document)
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange()
      range.getClientRects = () =>
        [range.startContainer.parentElement!.getBoundingClientRect()] as unknown as DOMRectList
      return range
    })
    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const previousCaretRange = documentWithCaret.caretRangeFromPoint
    documentWithCaret.caretRangeFromPoint = () => {
      const range = document.createRange()
      range.setStart(reader.firstChild!, 6)
      range.setEnd(reader.firstChild!, 7)
      return range
    }
    try {
      fireEvent.wheel(scroller, { deltaY: -1 })
      const sampled = createUserViewportAnchor(scroller, scroller)!
      expect(sampled.textOffset).toBe(6)
      const textTop = getTextOffsetRect(reader, sampled.textOffset!)!.top
      earlierChunk.replaceChildren(semanticAnchor(-1_100), semanticAnchor(-600))
      setReaderLayoutShift(-40)

      expect(findUserViewportAnchor(scroller, sampled)).toBe(reader)
      act(() => virtualLayoutCallback!())

      expect(scroller.scrollTop).toBe(-9_623)
      expect(getTextOffsetRect(reader, sampled.textOffset!)!.top).toBe(textTop)
      expect(sampled.textOffset).toBe(6)
    } finally {
      if (previousCaretRange) documentWithCaret.caretRangeFromPoint = previousCaretRange
      else delete documentWithCaret.caretRangeFromPoint
    }
  })

  test.each(['paragraph replacement', 'virtual row remount'])(
    'drops an anchor removed by %s instead of resolving another node at the same ordinal',
    kind => {
      const { scroller, reader, sampled } = renderPausedReader()
      const scrollTop = scroller.scrollTop
      if (kind === 'paragraph replacement') {
        reader.replaceWith(semanticAnchor(-1_100))
      } else {
        const message = reader.closest<HTMLElement>('[data-message-id]')!
        const replacement = message.cloneNode(true) as HTMLElement
        replacement.querySelector<HTMLElement>('[data-scroll-anchor]')!.getBoundingClientRect =
          () => new DOMRect(0, -1_100, 736, 24)
        message.replaceWith(replacement)
      }

      expect(findUserViewportAnchor(scroller, sampled)).toBeNull()
      act(() => virtualLayoutCallback!())

      expect(scroller.scrollTop).toBe(scrollTop)
    }
  )
})
