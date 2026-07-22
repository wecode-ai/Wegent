import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { DesktopAppBrandSwitcher } from './DesktopAppBrandSwitcher'

function renderWithCloud(
  ui: React.ReactNode,
  { isConnected = true }: { isConnected?: boolean } = {}
) {
  return render(
    <CloudConnectionContext.Provider
      value={{
        isConnected,
        status: isConnected ? 'connected' : 'disconnected',
        serviceKey: '',
        token: null,
        tokenExpiresAt: null,
        user: null,
        connectedAt: null,
        error: null,
        connectWithAuthorization: vi.fn(),
        refreshUser: vi.fn(),
        disconnect: vi.fn(),
      }}
    >
      {ui}
    </CloudConnectionContext.Provider>
  )
}

describe('DesktopAppBrandSwitcher', () => {
  test('renders wework brand button', () => {
    renderWithCloud(<DesktopAppBrandSwitcher onNavigate={vi.fn()} />)
    expect(screen.getByTestId('desktop-app-brand-switcher')).toHaveTextContent('wework')
  })

  test('opens menu on click', async () => {
    renderWithCloud(<DesktopAppBrandSwitcher onNavigate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('desktop-app-brand-switcher'))
    await waitFor(() =>
      expect(screen.getByTestId('desktop-app-brand-switcher-menu')).toBeInTheDocument()
    )
    expect(screen.getByTestId('brand-switcher-wework')).toBeInTheDocument()
    expect(screen.getByTestId('brand-switcher-wegent')).toBeInTheDocument()
  })

  test('calls onNavigate when selecting wework', async () => {
    const onNavigate = vi.fn()
    renderWithCloud(<DesktopAppBrandSwitcher onNavigate={onNavigate} />)
    fireEvent.click(screen.getByTestId('desktop-app-brand-switcher'))
    await waitFor(() => screen.getByTestId('brand-switcher-wework'))
    fireEvent.click(screen.getByTestId('brand-switcher-wework'))
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('wework'))
  })

  test('calls onNavigate when selecting wegent', async () => {
    const onNavigate = vi.fn()
    renderWithCloud(<DesktopAppBrandSwitcher onNavigate={onNavigate} />)
    fireEvent.click(screen.getByTestId('desktop-app-brand-switcher'))
    await waitFor(() => screen.getByTestId('brand-switcher-wegent'))
    fireEvent.click(screen.getByTestId('brand-switcher-wegent'))
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('wegent'))
  })

  test('disables wegent when cloud is not connected', async () => {
    const onNavigate = vi.fn()
    renderWithCloud(<DesktopAppBrandSwitcher onNavigate={onNavigate} />,
      { isConnected: false }
    )
    fireEvent.click(screen.getByTestId('desktop-app-brand-switcher'))
    await waitFor(() => screen.getByTestId('brand-switcher-wegent'))
    expect(screen.getByTestId('brand-switcher-wegent')).toBeDisabled()
  })
})
