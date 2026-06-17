import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppUpdateTitlebarButton } from './AppUpdateTitlebarButton'

const mockInstallUpdate = vi.fn()
let mockUpdateState = {
  availableUpdate: null as null | { currentVersion: string; version: string },
  status: 'idle',
  installUpdate: mockInstallUpdate,
}

vi.mock('@/features/app-update/app-update-context', () => ({
  useAppUpdate: () => mockUpdateState,
}))

describe('AppUpdateTitlebarButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateState = {
      availableUpdate: null,
      status: 'idle',
      installUpdate: mockInstallUpdate,
    }
  })

  test('stays hidden when no update is available', () => {
    render(<AppUpdateTitlebarButton />)
    expect(screen.queryByTestId('titlebar-app-update-button')).not.toBeInTheDocument()
  })

  test('installs the available update when clicked', async () => {
    mockUpdateState = {
      availableUpdate: { currentVersion: '0.1.0', version: '0.1.1' },
      status: 'available',
      installUpdate: mockInstallUpdate,
    }

    render(<AppUpdateTitlebarButton />)

    const button = screen.getByTestId('titlebar-app-update-button')
    expect(button).toHaveTextContent('更新')
    await userEvent.click(button)

    expect(mockInstallUpdate).toHaveBeenCalledTimes(1)
  })
})
