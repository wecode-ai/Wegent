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
