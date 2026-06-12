import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import './../../../src/i18n'
import { MobileSettingsPage } from './MobileSettingsPage'
import { AppearanceProvider } from '@/features/appearance'

describe('MobileSettingsPage', () => {
  test('renders mobile settings actions and opens plugins', async () => {
    const onBack = vi.fn()
    const onOpenPlugins = vi.fn()

    render(
      <AppearanceProvider>
        <MobileSettingsPage
          onBack={onBack}
          onOpenPlugins={onOpenPlugins}
        />
      </AppearanceProvider>,
    )

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-appearance-button')).toHaveTextContent(
      '外观',
    )
    expect(screen.getByTestId('mobile-settings-plugins-button')).toHaveTextContent(
      '插件',
    )
    expect(screen.getByTestId('mobile-settings-personal-button')).toHaveTextContent(
      '个人',
    )
    expect(screen.getByTestId('mobile-settings-worktrees-button')).toHaveTextContent(
      '工作树',
    )

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-codex-auth-button')).toHaveTextContent(
      'Codex 认证',
    )

    await userEvent.click(screen.getByTestId('mobile-personal-back-button'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-settings-plugins-button'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('mobile-settings-back-button'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('opens appearance settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>,
    )

    await userEvent.click(screen.getByTestId('mobile-settings-appearance-button'))

    expect(screen.getByTestId('mobile-appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-appearance-back-button'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
  })
})
