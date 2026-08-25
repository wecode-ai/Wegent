import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'

describe('MacOSTitleBarDragRegion', () => {
  test('marks the region for native Electron dragging', () => {
    render(<MacOSTitleBarDragRegion className="flex-1" />)

    expect(screen.getByTestId('macos-titlebar-drag-region')).toHaveClass(
      'electron-titlebar-drag-region',
      'pointer-events-auto',
      'flex-1'
    )
  })

  test('uses the full available titlebar area by default', () => {
    render(<MacOSTitleBarDragRegion />)

    expect(screen.getByTestId('macos-titlebar-drag-region')).toHaveClass('h-full', 'w-full')
  })
})
