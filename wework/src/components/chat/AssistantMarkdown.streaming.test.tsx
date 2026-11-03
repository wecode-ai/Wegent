import '@/styles/globals.css'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  getConversationDiagnosticsSnapshot,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '../../../../packages/collaboration/src/conversation/conversationDiagnostics'
import { AssistantMarkdown } from './AssistantMarkdown'

const runtimeMock = vi.hoisted(() => ({ electron: false }))

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isElectronRuntime: () => runtimeMock.electron,
}))

describe('AssistantMarkdown streaming stability', () => {
  afterEach(() => {
    runtimeMock.electron = false
    resetConversationDiagnosticsForTest()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test.each([true, false])(
    'records bounded Markdown expansion without transcript content (capture at mount: %s)',
    captureAtMount => {
      runtimeMock.electron = true
      if (captureAtMount) startConversationDiagnosticCapture()
      const recordedEvents = () =>
        (getConversationDiagnosticsSnapshot()?.events ?? []).map(({ name, details }) => ({
          name,
          details,
        }))
      let notifyIntersection: IntersectionObserverCallback | undefined
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(callback: IntersectionObserverCallback) {
            notifyIntersection = callback
          }
          observe() {}
          disconnect() {}
        }
      )
      let chunkTop = 2_300
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        const height = this.hasAttribute('data-markdown-window-chunk')
          ? this.querySelector('[data-markdown-window-placeholder]')
            ? 120
            : 300
          : 400
        const top = this.hasAttribute('data-markdown-window-chunk') ? chunkTop : 40
        return { height, width: 600, top, bottom: top + height, left: 0, right: 600 } as DOMRect
      })
      const content = '### Private heading\n\n**PRIVATE transcript marker**'
      const view = render(
        <div data-scroll-origin="bottom">
          <div data-index="7">
            <AssistantMarkdown content={content} />
          </div>
        </div>
      )
      const chunk = view.container.querySelector('[data-markdown-window-chunk]')!
      expect(chunk.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()
      if (captureAtMount) {
        expect(recordedEvents()).toContainEqual({
          name: 'markdown-layout',
          details: expect.objectContaining({
            rendered: false,
            reservedHeight: 120,
            height: 120,
            contentLength: content.length,
          }),
        })
      } else {
        expect(getConversationDiagnosticsSnapshot()).toBeNull()
      }
      startConversationDiagnosticCapture()

      chunkTop = 40
      act(() => {
        notifyIntersection!(
          [
            {
              target: chunk,
              isIntersecting: true,
              intersectionRatio: 0.5,
              rootBounds: { height: 900 },
              intersectionRect: { height: 60 },
              boundingClientRect: { top: 40 },
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        )
      })

      expect(chunk.querySelector('[data-markdown-window-placeholder]')).toBeNull()
      expect(chunk.querySelector('h3')).toHaveTextContent('Private heading')
      expect(recordedEvents()).toContainEqual({
        name: 'markdown-intersection',
        details: expect.objectContaining({
          scrollerId: 1,
          rowIndex: 7,
          rendered: false,
          intersection: 0.5,
          height: 120,
          rootHeight: 900,
          scrollerHeight: 400,
        }),
      })
      expect(recordedEvents()).toContainEqual({
        name: 'markdown-layout',
        details: expect.objectContaining({
          chunkIndex: 0,
          rendered: true,
          previousHeight: 120,
          height: 300,
          heightDelta: 180,
        }),
      })
      view.unmount()
      expect(recordedEvents()).toContainEqual({
        name: 'markdown-unmounted',
        details: expect.objectContaining({ rendered: true, height: 300 }),
      })
      for (const { details } of recordedEvents()) {
        expect(
          Object.values(details).every(value => ['number', 'boolean'].includes(typeof value))
        ).toBe(true)
      }
      expect(JSON.stringify(recordedEvents())).not.toContain('PRIVATE transcript marker')
      expect(JSON.stringify(recordedEvents())).not.toContain('Private heading')
    }
  )
})
