import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { AppearanceSettingsPage } from './AppearanceSettingsPage'

describe('AppearanceSettingsPage', () => {
  test('uses neutral controls and a blue default accent instead of green', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>,
    )

    const systemMode = screen.getByTestId('appearance-mode-system')
    expect(systemMode).toHaveClass('bg-text-primary', 'text-background')
    expect(systemMode).not.toHaveClass('bg-primary', 'text-primary-contrast')

    expect(screen.getByTestId('appearance-accent-input')).toHaveValue('#2563eb')
  })
})
