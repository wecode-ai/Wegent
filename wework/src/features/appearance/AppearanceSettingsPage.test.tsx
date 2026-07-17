import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { AppearanceSettingsPage } from './AppearanceSettingsPage'

describe('AppearanceSettingsPage', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
  })

  test('uses neutral controls and a blue default accent instead of green', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const systemMode = screen.getByTestId('appearance-mode-system')
    expect(systemMode).toHaveClass('bg-text-primary', 'text-background')
    expect(systemMode).not.toHaveClass('bg-primary', 'text-primary-contrast')

    expect(screen.getByTestId('appearance-accent-input')).toHaveValue('#2563eb')
    expect(screen.getByTestId('appearance-background-select-button')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-background-visibility-slider')).toBeDisabled()
    expect(screen.getByTestId('appearance-background-blur-slider')).toBeDisabled()

    const blurSlider = screen.getByTestId('appearance-background-blur-slider')
    const areaSelector = screen.getByTestId('appearance-background-area-main')
    expect(blurSlider.compareDocumentPosition(areaSelector)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('commits UI and code font sizes on Enter or blur', async () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const uiInput = screen.getByTestId('appearance-ui-font-size-input')
    const codeInput = screen.getByTestId('appearance-code-font-size-input')
    expect(uiInput).toHaveValue(14)
    expect(codeInput).toHaveValue(12)

    await userEvent.clear(uiInput)
    await userEvent.type(uiInput, '16{Enter}')
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('16px')

    await userEvent.clear(codeInput)
    await userEvent.type(codeInput, '15')
    fireEvent.blur(codeInput)
    expect(document.documentElement.style.getPropertyValue('--text-code')).toBe('15px')
  })

  test('clamps out-of-range values and restores invalid input', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const uiInput = screen.getByTestId('appearance-ui-font-size-input') as HTMLInputElement
    fireEvent.change(uiInput, { target: { value: '99' } })
    fireEvent.blur(uiInput)
    expect(uiInput.value).toBe('16')

    const codeInput = screen.getByTestId('appearance-code-font-size-input') as HTMLInputElement
    fireEvent.change(codeInput, { target: { value: '' } })
    fireEvent.blur(codeInput)
    expect(codeInput.value).toBe('12')
  })

  test('lets users choose which interface areas show the background', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/background.png' })
    )
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const main = screen.getByTestId('appearance-background-area-main')
    const sidebar = screen.getByTestId('appearance-background-area-sidebar')
    const topbar = screen.getByTestId('appearance-background-area-topbar')
    expect(main).toBeChecked()
    expect(sidebar).toBeChecked()
    expect(topbar).toBeChecked()

    await userEvent.click(sidebar)

    expect(sidebar).not.toBeChecked()
    expect(localStorage.getItem('wework.appearance')).toContain('"backgroundInSidebar":false')
  })
})
