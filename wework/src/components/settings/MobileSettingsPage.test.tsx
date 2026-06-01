import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import './../../../src/i18n'
import { MobileSettingsPage } from './MobileSettingsPage'

describe('MobileSettingsPage', () => {
  test('renders mobile settings actions and opens plugins', async () => {
    const onBack = vi.fn()
    const onOpenPlugins = vi.fn()

    render(
      <MobileSettingsPage
        onBack={onBack}
        onOpenPlugins={onOpenPlugins}
      />,
    )

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-settings-plugins-button')).toHaveTextContent(
      '插件',
    )

    await userEvent.click(screen.getByTestId('mobile-settings-plugins-button'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('mobile-settings-back-button'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
