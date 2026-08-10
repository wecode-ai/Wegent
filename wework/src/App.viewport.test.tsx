import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useTauriViewportSize } from '@/hooks/useTauriViewportSize'

function physicalSize(width: number, height: number) {
  return {
    width,
    height,
    toLogical: (scaleFactor: number) => ({
      width: width / scaleFactor,
      height: height / scaleFactor,
    }),
  }
}

const windowMocks = vi.hoisted(() => ({
  innerSize: vi.fn(),
  scaleFactor: vi.fn(),
  onResized: vi.fn(),
  onScaleChanged: vi.fn(),
  resizeHandler: null as ((event: { payload: ReturnType<typeof physicalSize> }) => void) | null,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    innerSize: windowMocks.innerSize,
    scaleFactor: windowMocks.scaleFactor,
    onResized: windowMocks.onResized,
    onScaleChanged: windowMocks.onScaleChanged,
  }),
}))

beforeEach(() => {
  windowMocks.resizeHandler = null
  windowMocks.innerSize.mockReset().mockResolvedValue(physicalSize(1280, 720))
  windowMocks.scaleFactor.mockReset().mockResolvedValue(1)
  windowMocks.onResized.mockReset().mockImplementation(async handler => {
    windowMocks.resizeHandler = handler
    return vi.fn()
  })
  windowMocks.onScaleChanged.mockReset().mockResolvedValue(vi.fn())
})

test('keeps the latest native viewport size when resize conversions finish out of order', async () => {
  const { result } = renderHook(() => useTauriViewportSize(true))

  await waitFor(() => {
    expect(windowMocks.resizeHandler).not.toBeNull()
    expect(result.current).toEqual({ width: 1280, height: 720 })
  })

  let resolveStaleScaleFactor: ((scaleFactor: number) => void) | undefined
  const staleScaleFactor = new Promise<number>(resolve => {
    resolveStaleScaleFactor = resolve
  })
  windowMocks.scaleFactor.mockReturnValueOnce(staleScaleFactor).mockResolvedValueOnce(1)

  act(() => {
    windowMocks.resizeHandler?.({ payload: physicalSize(1504, 929) })
    windowMocks.resizeHandler?.({ payload: physicalSize(1728, 1084) })
  })

  await waitFor(() => {
    expect(result.current).toEqual({ width: 1728, height: 1084 })
  })

  await act(async () => {
    resolveStaleScaleFactor?.(1)
    await staleScaleFactor
  })

  expect(result.current).toEqual({ width: 1728, height: 1084 })
})
