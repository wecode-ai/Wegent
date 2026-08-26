import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { WorkbenchBackground } from './WorkbenchBackground'

vi.mock('@/components/chat/assistantMarkdownLinks', () => ({
  desktopFileUrl: vi.fn((path: string) => `wework-file://${path}`),
}))

describe('WorkbenchBackground', () => {
  beforeEach(() => localStorage.clear())

  test('shows the image without a theme overlay at full visibility', () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        backgroundImagePath: '/app-data/background.png',
        backgroundVisibility: 100,
        backgroundBlur: 12,
      })
    )

    render(
      <AppearanceProvider>
        <WorkbenchBackground />
      </AppearanceProvider>
    )

    expect(screen.getByTestId('workbench-background-overlay')).toHaveStyle({ opacity: 0 })
    expect(screen.getByRole('presentation', { hidden: true })).toHaveStyle({
      filter: 'blur(12px)',
    })
  })

  test('hides a background image that cannot be loaded', () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/background.png' })
    )

    render(
      <AppearanceProvider>
        <WorkbenchBackground />
      </AppearanceProvider>
    )
    fireEvent.error(screen.getByRole('presentation', { hidden: true }))

    expect(screen.queryByTestId('workbench-background')).not.toBeInTheDocument()
  })
})
