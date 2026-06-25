import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import './../../../src/i18n'
import { MobileSettingsPage } from './MobileSettingsPage'
import { AppearanceProvider } from '@/features/appearance'

describe('MobileSettingsPage', () => {
  test('renders mobile settings actions without unreleased plugins navigation', async () => {
    const onBack = vi.fn()
    const onOpenPlugins = vi.fn()

    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={onBack} onOpenPlugins={onOpenPlugins} />
      </AppearanceProvider>
    )

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-appearance-button')).toHaveTextContent('外观')
    expect(screen.queryByTestId('mobile-settings-plugins-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-personal-button')).toHaveTextContent('个人')
    expect(screen.getByTestId('mobile-settings-worktrees-button')).toHaveTextContent('工作树')
    expect(screen.getByTestId('mobile-settings-archived-conversations-button')).toHaveTextContent(
      '已归档对话'
    )
    expect(screen.getByTestId('mobile-settings-skills-button')).toHaveTextContent('技能')

    await userEvent.click(screen.getByTestId('mobile-settings-personal-button'))
    expect(screen.getByTestId('mobile-personal-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-codex-auth-button')).toHaveTextContent('Codex 认证')

    await userEvent.click(screen.getByTestId('mobile-personal-back-button'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-settings-back-button'))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onOpenPlugins).not.toHaveBeenCalled()
  })

  test('opens appearance settings on mobile', async () => {
    render(
      <AppearanceProvider>
        <MobileSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('mobile-settings-appearance-button'))

    expect(screen.getByTestId('mobile-appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-appearance-back-button'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
  })
})
