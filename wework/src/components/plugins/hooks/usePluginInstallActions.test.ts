import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import { queueMarketplacePluginTrial } from '../workspace/marketplaceWorkspaceHelpers'
import { usePluginInstallActions } from './usePluginInstallActions'

vi.mock('../workspace/marketplaceWorkspaceHelpers', async importOriginal => ({
  ...(await importOriginal<typeof import('../workspace/marketplaceWorkspaceHelpers')>()),
  queueMarketplacePluginTrial: vi.fn(() => true),
}))

test.each(['prompt', 'chat'] as const)(
  'blocks the shared %s trial entry until uninstall settles',
  entry => {
    vi.mocked(queueMarketplacePluginTrial).mockClear()
    const item = { id: 101, name: 'documents' } as PluginMarketplaceItem
    let uninstalling = true
    const isUninstalling = vi.fn(() => uninstalling)
    const setPluginMarketplaceState = vi.fn()
    const { result } = renderHook(() =>
      usePluginInstallActions({
        installedPlugins: [],
        localPluginApi: { rememberMarketplaceSelection: vi.fn() },
        isUninstalling,
        setPluginMarketplaceState,
        t: (_key, fallback) => fallback,
      })
    )
    const invoke = () =>
      entry === 'prompt'
        ? result.current.beginMarketplacePluginTrial(item, null, 'Review this change')
        : result.current.tryMarketplacePluginInChat(item)
    invoke()
    expect(isUninstalling).toHaveBeenCalledWith(item)
    expect(queueMarketplacePluginTrial).not.toHaveBeenCalled()
    expect(setPluginMarketplaceState).not.toHaveBeenCalled()
    uninstalling = false
    invoke()
    expect(queueMarketplacePluginTrial).toHaveBeenCalledOnce()
    expect(queueMarketplacePluginTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        item,
        prompt: entry === 'prompt' ? 'Review this change' : undefined,
      })
    )
  }
)
