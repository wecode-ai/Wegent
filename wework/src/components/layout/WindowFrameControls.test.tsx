import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WindowFrameControls } from './WindowFrameControls'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn().mockResolvedValue({ maximized: false }),
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

test('restores neutral Wework controls without overriding the native red close control', () => {
  render(<WindowFrameControls />)
  for (const id of ['window-minimize-button', 'window-maximize-button']) {
    expect(screen.getByTestId(id)).toHaveClass('wework:hover:bg-black/[0.08]')
  }
  expect(screen.getByTestId('window-close-button')).toHaveClass('hover:bg-[#e81123]')
  expect(screen.getByTestId('window-close-button')).not.toHaveClass(
    'wework:hover:bg-black/[0.08]',
    'wework:active:bg-black/[0.12]'
  )
})
