import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationVirtualizer } from '../../../../packages/collaboration/src/conversation/useConversationVirtualizer'
import { useMessageRowMeasure } from '../../../../packages/collaboration/src/conversation/useMessageRowMeasurements'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

test.each([606.47])(
  'initial and observed heights both round %s consistently, without re-reading observed DOM',
  async height => {
    const row = document.createElement('div')
    row.dataset.index = '0'
    const bounds = vi
      .spyOn(row, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 700, height))
    const engine = {
      options: { estimateSize: () => 220 },
      getVirtualItems: () => [{ index: 0, size: 220 }],
      getTotalSize: () => 220,
    } as unknown as ConversationVirtualizer
    const callback = vi.fn()
    const hook = renderHook(() => useMessageRowMeasure(callback))
    expect(hook.result.current(row, undefined, engine)).toBe(Math.round(height))
    bounds.mockClear()
    const entry = {
      target: row,
      borderBoxSize: [{ inlineSize: 700, blockSize: height }],
    } as unknown as ResizeObserverEntry
    expect(hook.result.current(row, entry, engine)).toBe(Math.round(height))
    expect(bounds).not.toHaveBeenCalled()
    await act(async () => {})
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ previousSize: 220, measuredSize: Math.round(height) })
    )
    hook.unmount()
  }
)
