import { useMemo } from 'react'
import { useRuntimeComposerCatalog } from '@/components/chat/composer/useRuntimeComposerCatalog'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'

/** Keep configuration drafts mounted while browsing available plugins. */
export function useStandInComposerCatalog(...args: Parameters<typeof useRuntimeComposerCatalog>) {
  const catalog = useRuntimeComposerCatalog(...args)
  const tabs = useOptionalWorkspaceTabs()
  return useMemo(
    () => ({
      ...catalog,
      openMarketplace: tabs
        ? () => tabs.openTab('auxiliary', { contentRoute: '/plugins' })
        : undefined,
    }),
    [catalog, tabs]
  )
}
