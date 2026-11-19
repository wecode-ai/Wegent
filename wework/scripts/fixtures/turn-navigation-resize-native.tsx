import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageTurnNavigation } from '../../../packages/collaboration/src/conversation/MessageTurnNavigation'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

export function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <div
        ref={scrollRef}
        id="navigation-resize-viewport"
        style={{ width: 600, height: 300, overflow: 'auto', overflowAnchor: 'none' }}
      >
        <div ref={contentRef}>
          <div style={{ height: 600 }} />
          <article data-message-id="question" style={{ height: 100 }}>
            Question
          </article>
          <div style={{ height: 800 }} />
        </div>
      </div>
      <MessageTurnNavigation
        scrollRef={scrollRef}
        contentRef={contentRef}
        messageTarget={{ messageId: 'question', requestKey: 'open-question' }}
        messages={[{ id: 'question', role: 'user', content: 'Question' }]}
        translate={key => key}
      />
    </>
  )
}

Object.assign(window, {
  async runTurnNavigationResizeContract() {
    const errors: string[] = []
    const collect = (event: ErrorEvent) => errors.push(event.message)
    addEventListener('error', collect)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      root.render(<Fixture />)
      let viewport: HTMLElement | null = null
      for (let i = 0; i < 120; i++) {
        await frame()
        viewport = document.getElementById('navigation-resize-viewport')
        if (viewport && viewport.scrollTop > 0) break
      }
      if (!viewport || viewport.scrollTop === 0)
        throw new Error('Question navigation did not locate its anchor')
      // Let the initial navigation acknowledge its target before viewport notifications.
      await frame()
      await frame()
      const expected = viewport.scrollTop
      const offsets: number[] = []
      for (const height of [240, 320, 260, 340]) {
        viewport.style.height = `${height}px`
        // Sample the settled business position as well as native observer errors.
        for (let i = 0; i < 4; i++) await frame()
        offsets.push(viewport.scrollTop - expected)
      }
      const resizedViewport = viewport
      // The product observer runs first and queues reacquisition. User input
      // in the same delivery must cancel that pending work before its frame.
      await new Promise<void>(resolve => {
        const observer = new ResizeObserver(() => {
          resizedViewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }))
          resizedViewport.scrollTop = 100
          observer.disconnect()
          resolve()
        })
        observer.observe(resizedViewport)
        resizedViewport.style.height = '280px'
      })
      for (let i = 0; i < 4; i++) await frame()
      return { errors, offsets, cancelledScrollTop: viewport.scrollTop }
    } finally {
      root.unmount()
      host.remove()
      removeEventListener('error', collect)
    }
  },
})
