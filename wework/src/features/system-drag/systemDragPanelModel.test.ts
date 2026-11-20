import { expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { createSystemDragPanelModel } from './systemDragPanelModel'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
  subscribeDesktopHostEvents: vi.fn(() => () => undefined),
}))

test('uses the input time when a reopened native panel receives Escape before context refresh', async () => {
  const invoke = vi.mocked(invokeDesktopHost)
  invoke.mockImplementation(async capability => {
    if (capability === 'systemDrag.getContext') {
      return { presentationId: 1, conversationTitle: 'Previous presentation' }
    }
    return true
  })
  const panel = createSystemDragPanelModel()
  const stop = panel.subscribe(() => undefined)
  try {
    await vi.waitFor(() =>
      expect(panel.getSnapshot().conversationTitle).toBe('Previous presentation')
    )
    invoke.mockClear()
    const before = Date.now()
    panel.dismiss()
    const after = Date.now()
    expect(invoke).toHaveBeenCalledTimes(1)
    const [method, args] = invoke.mock.calls[0]
    expect(method).toBe('systemDrag.dismissPanel')
    expect(args).not.toHaveProperty('presentationId')
    expect(args?.inputAt).toBeGreaterThanOrEqual(before)
    expect(args?.inputAt).toBeLessThanOrEqual(after)
  } finally {
    stop()
  }
})
