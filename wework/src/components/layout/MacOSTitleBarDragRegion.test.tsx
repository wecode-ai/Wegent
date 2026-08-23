import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'

const startDragging = vi.fn().mockResolvedValue(undefined)
const runtime = vi.hoisted(() => ({ electron: false }))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => runtime.electron,
}))

describe('MacOSTitleBarDragRegion', () => {
  beforeEach(() => {
    startDragging.mockClear()
    runtime.electron = false
  })

  test('starts native dragging from the primary mouse button', async () => {
    render(<MacOSTitleBarDragRegion className="flex-1" />)

    fireEvent.mouseDown(screen.getByTestId('macos-titlebar-drag-region'), {
      button: 0,
    })

    await waitFor(() => expect(startDragging).toHaveBeenCalledTimes(1))
  })

  test('ignores non-primary mouse buttons', () => {
    render(<MacOSTitleBarDragRegion />)

    fireEvent.mouseDown(screen.getByTestId('macos-titlebar-drag-region'), {
      button: 1,
    })

    expect(startDragging).not.toHaveBeenCalled()
  })

  test('uses the native Electron app-region instead of Tauri dragging', () => {
    runtime.electron = true
    render(<MacOSTitleBarDragRegion />)
    const region = screen.getByTestId('macos-titlebar-drag-region')

    fireEvent.mouseDown(region, { button: 0 })

    expect(region).toHaveClass('electron-titlebar-drag-region')
    expect(startDragging).not.toHaveBeenCalled()
  })
})
