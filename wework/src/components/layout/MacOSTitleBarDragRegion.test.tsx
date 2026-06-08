import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'

const startDragging = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}))

describe('MacOSTitleBarDragRegion', () => {
  beforeEach(() => {
    startDragging.mockClear()
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
})
