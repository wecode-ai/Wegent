import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SmartAppsMarketplacePage } from './SmartAppsMarketplacePage'

const navigateTo = vi.fn()
const queuePluginReferenceTrial = vi.fn()

vi.mock('@/components/layout/DesktopTopBar', () => ({
  DesktopTopBar: () => null,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/navigation', () => ({
  navigateTo: (path: string) => navigateTo(path),
}))

vi.mock('@/features/plugins/pluginTrial', () => ({
  queuePluginReferenceTrial: (options: unknown) => queuePluginReferenceTrial(options),
}))

describe('SmartAppsMarketplacePage', () => {
  beforeEach(() => {
    navigateTo.mockReset()
    queuePluginReferenceTrial.mockReset()
  })

  test('keeps marketplace and installed Smart apps as separate destinations', () => {
    render(<SmartAppsMarketplacePage />)

    expect(screen.getByTestId('smart-apps-section-marketplace')).toHaveAttribute(
      'aria-current',
      'page'
    )

    fireEvent.click(screen.getByTestId('smart-apps-marketplace-create'))
    expect(queuePluginReferenceTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginName: 'smart-app-builder',
        marketplaceName: 'wework-personal',
        openInNewChat: true,
      })
    )
    expect(navigateTo).toHaveBeenLastCalledWith('/')

    fireEvent.click(screen.getByTestId('smart-apps-marketplace-import'))
    expect(navigateTo).toHaveBeenLastCalledWith(
      '/sites?app_type=smart_app&view=installed&action=import'
    )

    fireEvent.click(screen.getByTestId('smart-apps-marketplace-installed'))
    expect(navigateTo).toHaveBeenLastCalledWith('/sites?app_type=smart_app&view=installed')
  })
})
