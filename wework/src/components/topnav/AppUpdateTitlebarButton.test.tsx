import type { WeworkUpdateInfo } from '@/lib/app-updater'
import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppUpdateTitlebarButton } from './AppUpdateTitlebarButton'

const mockInstallUpdate = vi.fn()
let mockUpdateState = {
  availableUpdate: null as WeworkUpdateInfo | null,
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

  test('labels a rollback explicitly in the title bar', () => {
    mockUpdateState.availableUpdate = {
      currentVersion: '0.5.0-beta.1',
      version: '0.4.3',
      kind: 'downgrade-to-stable',
    }
    mockUpdateState.status = 'available'
    render(<AppUpdateTitlebarButton />)
    expect(screen.getByTestId('titlebar-app-update-button')).toHaveTextContent('回到正式版 0.4.3')
  })

  test('stays hidden when no update is available', () => {
    render(<AppUpdateTitlebarButton />)
    expect(screen.queryByTestId('titlebar-app-update-button')).not.toBeInTheDocument()
  })

  test('installs the available update when clicked', async () => {
    mockUpdateState = {
      availableUpdate: {
        kind: 'upgrade-stable' as const,
        currentVersion: '0.1.0',
        version: '0.1.1',
      },
      status: 'available',
      installUpdate: mockInstallUpdate,
    }

    render(<AppUpdateTitlebarButton />)

    const button = screen.getByTestId('titlebar-app-update-button')
    expect(button).toHaveTextContent('升级到正式版 0.1.1')
    await userEvent.click(button)

    expect(mockInstallUpdate).toHaveBeenCalledTimes(1)
  })
})
