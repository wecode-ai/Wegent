import { synchronizeConversationScrollOffset } from '../../../packages/collaboration/src/conversation/conversationScrollWrite'
import { flushSync } from 'react-dom'
import { createConversationScrollState } from '../../../packages/collaboration/src/conversation/conversationScrollState'
import './turn-navigation-resize-native'
import { createRoot } from 'react-dom/client'
import { useLayoutEffect, useRef, useState } from 'react'
import {
  useConversationVirtualizer,
  type ConversationVirtualizer,
} from '../../../packages/collaboration/src/conversation/useConversationVirtualizer'
import { useMessageRowMeasurements } from '../../../packages/collaboration/src/conversation/useMessageRowMeasurements'

const errors: string[] = []
const viewportRef = { current: null as HTMLDivElement | null }
const engineRef = { current: null as ConversationVirtualizer | null }
let pendingHeight = 0
addEventListener('error', event => errors.push(event.message))

export function Header() {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(20)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!pendingHeight) return
      setHeight(current => (current === 20 ? 30 : 20))
      document.querySelector<HTMLElement>('[data-message-row]')!.style.height = `${pendingHeight}px`
      pendingHeight = 0
    })
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [])
  return <div id="header" ref={ref} style={{ width: 100, height }} />
}

export function Rows() {
  const listRef = useRef<HTMLDivElement>(null)
  const { virtualizer, scrollMargin } = useConversationVirtualizer({
    count: 80,
    enabled: true,
    estimateSize: () => 100,
    scrollElementRef: viewportRef,
    listRef,
    virtualizerRef: engineRef,
    initialDistanceFromBottomPx: 0,
  })
  useMessageRowMeasurements(listRef, virtualizer, true)
  const rows = virtualizer.getVirtualItems()
  return (
    <div ref={listRef} style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((row, position) => (
        <div
          key={row.key}
          data-message-row
          data-index={row.index}
          style={{
            height: 100,
            flexShrink: 0,
            marginTop: row.start - (rows[position - 1]?.end ?? scrollMargin),
          }}
        >
          Row {row.index}
        </div>
      ))}
      <div
        style={{ height: virtualizer.getTotalSize() - (rows.at(-1)?.end ?? 0), flexShrink: 0 }}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <>
    <Header />
    <div
      ref={element => {
        viewportRef.current = element
      }}
      style={{ width: 800, height: 200, overflow: 'auto', overflowAnchor: 'none' }}
    >
      <Rows />
    </div>
  </>
)

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const viewport = viewportRef.current
    if (
      engineRef.current?.options.enabled &&
      viewport &&
      viewport.scrollTop > 0 &&
      Math.abs(viewport.scrollTop + viewport.clientHeight - viewport.scrollHeight) < 1
    )
      return viewport
    await frame()
  }
  throw new Error('Native conversation virtualizer did not reach its initial end position')
}

Object.assign(window, {
  async runConversationResizeContract() {
    const viewport = await ready()
    const anchorOffsets: number[] = []
    for (const height of [400, 800, 400, 800]) {
      const bounds = viewport.getBoundingClientRect()
      const anchor = [...document.querySelectorAll<HTMLElement>('[data-message-row]')].find(row => {
        const top = row.getBoundingClientRect().top
        return top >= bounds.top && top < bounds.bottom
      })!
      const before = anchor.getBoundingClientRect().top - bounds.top
      pendingHeight = height
      const header = document.getElementById('header')!
      header.style.width = `${header.clientWidth + 1}px`
      for (let sample = 0; sample < 5; sample++) {
        await frame()
        if (!anchor.isConnected) throw new Error('Size compensation discarded the reading anchor')
        anchorOffsets.push(
          anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - before
        )
      }
    }
    const uncovered: Array<{ offset: number; sample: number }> = []
    let scrollSamples = 0
    for (const offset of [0, 1000, 5000, 7700, 0]) {
      viewport.scrollTop = offset
      for (let sample = 0; sample < 3; sample++) {
        await frame()
        const bounds = viewport.getBoundingClientRect()
        const rows = [...document.querySelectorAll('[data-message-row]')].map(row =>
          row.getBoundingClientRect()
        )
        scrollSamples++
        if (
          Math.min(...rows.map(row => row.top)) > bounds.top + 1 ||
          Math.max(...rows.map(row => row.bottom)) < bounds.bottom - 1
        )
          uncovered.push({ offset, sample })
      }
    }
    return { errors, anchorOffsets, scrollSamples, uncovered }
  },
})

// Reproduce the native clamp followed by virtual compensation observed on panel close.
function RangeClampRows() {
  const listRef = useRef<HTMLDivElement>(null)
  useConversationVirtualizer({
    count: 1,
    enabled: true,
    estimateSize: () => 5456,
    scrollElementRef: clampViewport,
    listRef,
    virtualizerRef: clampEngine,
    initialDistanceFromBottomPx: 0,
    onNativeScrollRange: () => clampReader?.captureNativeScrollRange(),
    onScrollAdjustment: delta => {
      if (clampState.anchor) clampState.selfScrollOffset += delta
    },
  })
  return (
    <div ref={listRef} style={{ height: 5456, position: 'relative' }}>
      <article data-message-id="clamp-anchor">
        <p
          id="clamp-anchor"
          data-scroll-anchor
          style={{ position: 'absolute', top: 2704, margin: 0 }}
        >
          Anchor
        </p>
      </article>
    </div>
  )
}

import {
  createReaderViewportAnchor,
  type ReaderViewportState,
} from '../../../packages/collaboration/src/conversation/readerViewportAnchor'
const clampViewport = { current: null as HTMLDivElement | null }
const clampEngine = { current: null as ConversationVirtualizer | null }
const clampState: ReaderViewportState = {
  anchor: null,
  selfScrollOffset: 0,
  lastMeasuredLayout: null,
  lastScrollPosition: null,
}
let clampReader: ReturnType<typeof createReaderViewportAnchor> | null = null
Object.assign(window, {
  async runNativeRangeClampContract() {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      root.render(
        <div
          ref={element => {
            clampViewport.current = element
          }}
          style={{ width: 1040, height: 643, overflow: 'auto', overflowAnchor: 'none' }}
        >
          <RangeClampRows />
        </div>
      )
      for (let i = 0; i < 120 && !clampEngine.current; i++) await frame()
      const viewport = clampViewport.current!
      if (!clampEngine.current) throw new Error('Range clamp virtualizer was not ready')
      const content = viewport.firstElementChild as HTMLDivElement
      const anchor = content.querySelector<HTMLElement>('#clamp-anchor')!
      viewport.scrollTop = 2700
      clampState.anchor = {
        messageId: 'clamp-anchor',
        itemId: null,
        chunkIndex: null,
        text: 'Anchor',
        element: anchor,
        anchorIndex: 0,
        textOffset: null,
        offsetFromScrollerTop: 4,
        scrollTopPx: 2700,
      }
      clampState.selfScrollOffset = 0
      clampReader = createReaderViewportAnchor(
        () => viewport,
        () => content,
        clampState
      )
      content.style.height = '3240px'
      anchor.style.top = '1889px'
      const clampedOffset = viewport.scrollTop
      clampEngine.current.scrollToOffset(2403, { behavior: 'auto' })
      clampReader.restoreReaderPositionFromLayout()
      const restoredOffset = viewport.scrollTop
      const anchorOffset = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const config = {
        messages: [
          {
            id: 'clamp-anchor',
            role: 'assistant' as const,
            status: 'done' as const,
            content: 'Anchor',
            createdAt: new Date().toISOString(),
          },
        ],
        geometry: null,
      }
      const state = createConversationScrollState(null, config)
      const stop = state.subscribe(
        () => {},
        { ...config, scrollRef: clampViewport },
        {
          scrollRef: clampViewport,
          contentRef: { current: content },
          virtualizerRef: { current: null },
          externalScrollInteractionRef: undefined,
          owner: { lease: null },
        }
      )
      let appendButton
      try {
        state.markInput(new WheelEvent('wheel', { deltaY: -40 }))
        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 40
        state.scroll()
        state.endInput()
        const before = state.getSnapshot().showScrollButton
        const beforeOffset = viewport.scrollTop
        content.style.height = '4240px'
        state.handleContentLayoutChange()
        appendButton = {
          before,
          after: state.getSnapshot().showScrollButton,
          offsetChange: viewport.scrollTop - beforeOffset,
        }
      } finally {
        stop()
      }
      return {
        appendButton,
        clampedOffset,
        restoredOffset,
        anchorOffset,
      }
    } finally {
      clampReader?.dispose()
      clampReader = null
      root.unmount()
      host.remove()
    }
  },
})

Object.assign(window, {
  async runNativeScrollCaptureContract() {
    const viewport = viewportRef.current!
    const engine = engineRef.current!
    engine.resizeItem(0, 100)
    engine.scrollToOffset(6000, { behavior: 'auto' })
    await frame()
    await frame()
    let pending = true
    const capture = (event: Event) => {
      if (event.target !== viewport || !pending) return
      pending = false
      synchronizeConversationScrollOffset(viewport)
      // A capture-phase Markdown render measures a row before the offset listener.
      flushSync(() => engine.resizeItem(0, 68))
    }
    window.addEventListener('scroll', capture, true)
    try {
      viewport.scrollTop = 3559
      viewport.dispatchEvent(new Event('scroll'))
      const appliedOffset = viewport.scrollTop
      return { requestedOffset: 3559, appliedOffset }
    } finally {
      window.removeEventListener('scroll', capture, true)
    }
  },
})
