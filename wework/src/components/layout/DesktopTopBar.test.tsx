import { render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { DesktopTopBar } from './DesktopTopBar'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}))

describe('DesktopTopBar', () => {
  test('renders a unified title bar with action groups and a drag region', () => {
    render(
      <DesktopTopBar
        left={<button type="button">Left</button>}
        right={<button type="button">Right</button>}
      />,
    )

    expect(screen.getByTestId('desktop-topbar')).toHaveClass(
      'h-[52px]',
      'items-center',
      'px-6',
    )
    expect(screen.getByTestId('desktop-topbar-left-actions')).toHaveClass(
      'gap-3.5',
    )
    expect(screen.getByTestId('desktop-topbar-right-actions')).toHaveClass(
      'gap-5',
      'ml-auto',
    )
    expect(
      within(screen.getByTestId('desktop-topbar-drag-region')).getByTestId(
        'macos-titlebar-drag-region',
      ),
    ).toHaveAttribute('data-tauri-drag-region')
  })
})
