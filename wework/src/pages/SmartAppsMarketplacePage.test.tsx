import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SmartAppsMarketplacePage } from './SmartAppsMarketplacePage'

const navigateTo = vi.fn()
const queuePluginReferenceTrial = vi.fn()
const ensureBundledPluginInstalled = vi.fn()

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

vi.mock('@/tauri/localExecutor', () => ({
  ensureBundledPluginInstalled: (pluginName: string) => ensureBundledPluginInstalled(pluginName),
}))

describe('SmartAppsMarketplacePage', () => {
  beforeEach(() => {
    navigateTo.mockReset()
    queuePluginReferenceTrial.mockReset()
    queuePluginReferenceTrial.mockReturnValue(true)
    ensureBundledPluginInstalled.mockReset()
    ensureBundledPluginInstalled.mockResolvedValue(undefined)
  })

  test('installs the builder before opening a referenced fresh chat', async () => {
    render(<SmartAppsMarketplacePage />)

    expect(screen.getByTestId('smart-apps-section-marketplace')).toHaveAttribute(
      'aria-current',
      'page'
    )

    fireEvent.click(screen.getByTestId('smart-apps-marketplace-create'))
    await waitFor(() => {
      expect(ensureBundledPluginInstalled).toHaveBeenCalledWith('smart-app-builder')
    })
    expect(queuePluginReferenceTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginName: 'smart-app-builder',
        marketplaceName: 'wework-personal',
        openInNewChat: true,
      })
    )
    expect(navigateTo).toHaveBeenLastCalledWith('/')
  })

  test('keeps marketplace and installed Smart apps as separate destinations', () => {
    render(<SmartAppsMarketplacePage />)

    fireEvent.click(screen.getByTestId('smart-apps-marketplace-import'))
    expect(navigateTo).toHaveBeenLastCalledWith(
      '/sites?app_type=smart_app&view=installed&action=import'
    )

    fireEvent.click(screen.getByTestId('smart-apps-marketplace-installed'))
    expect(navigateTo).toHaveBeenLastCalledWith('/sites?app_type=smart_app&view=installed')
  })

  test('stays on the marketplace when the builder cannot be installed', async () => {
    ensureBundledPluginInstalled.mockRejectedValue(new Error('install failed'))
    render(<SmartAppsMarketplacePage />)

    fireEvent.click(screen.getByTestId('smart-apps-marketplace-create'))

    expect(await screen.findByText('智能工作台开发助手安装失败，请重试。')).toBeInTheDocument()
    expect(queuePluginReferenceTrial).not.toHaveBeenCalled()
    expect(navigateTo).not.toHaveBeenCalled()
  })
})
