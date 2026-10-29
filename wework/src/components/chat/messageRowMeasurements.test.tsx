import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useMessageRowMeasurements } from '../../../../packages/collaboration/src/conversation/useMessageRowMeasurements'
import type { ConversationVirtualizer } from '../../../../packages/collaboration/src/conversation/useConversationVirtualizer'

afterEach(() => vi.unstubAllGlobals())

test.each([606.47, 1334.31, 2523.78])(
  'sync Markdown and ResizeObserver share the same rounded %s px measurement',
  height => {
    let notify: ResizeObserverCallback = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback
        }
        observe = observe
        unobserve = vi.fn()
        disconnect = disconnect
      }
    )
    const list = document.createElement('div')
    list.innerHTML =
      '<div data-message-row data-index="0"><article data-message-id="answer"></article></div>'
    const row = list.firstElementChild as HTMLElement
    let rowHeight = height
    row.getBoundingClientRect = () => new DOMRect(0, 0, 700, rowHeight)
    let size = 220
    const resizeItem = vi.fn((_index: number, measured: number) => {
      size = measured
    })
    const engine = {
      options: { count: 1, estimateSize: () => 220 },
      getVirtualItems: () => [{ index: 0, size }],
      getTotalSize: () => size,
      resizeItem,
    } as unknown as ConversationVirtualizer
    const callback = vi.fn()
    const hook = renderHook(() =>
      useMessageRowMeasurements({ current: list }, engine, true, callback)
    )
    expect(resizeItem).toHaveBeenCalledExactlyOnceWith(0, Math.round(height))
    expect(observe).toHaveBeenCalledExactlyOnceWith(row)
    act(() => {
      hook.result.current(row)
      notify(
        [
          { target: row, borderBoxSize: [{ blockSize: height }] },
        ] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver
      )
    })
    expect(resizeItem).toHaveBeenCalledTimes(1)
    rowHeight += 80.3
    act(() => hook.result.current(row))
    expect(resizeItem).toHaveBeenLastCalledWith(0, Math.round(rowHeight))
    expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'answer',
        previousSize: Math.round(height),
        measuredSize: Math.round(rowHeight),
      })
    )
    hook.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  }
)

test('hidden rows do not replace valid heights with zero', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const list = document.createElement('div')
  list.innerHTML = '<div data-message-row data-index="0"></div>'
  const resizeItem = vi.fn()
  renderHook(() =>
    useMessageRowMeasurements(
      { current: list },
      { options: { count: 1 }, resizeItem } as unknown as ConversationVirtualizer,
      true
    )
  )
  expect(resizeItem).not.toHaveBeenCalled()
})
