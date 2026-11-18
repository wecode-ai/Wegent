import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { pluginMarketplaceCacheKey } from '@/features/plugins/pluginMarketplaceCache'
import { usePluginsWorkspaceController } from './workspace/usePluginsWorkspaceController'
import { renderPluginWorkspaceDialogs } from './workspace/renderPluginWorkspaceDialogs'
import { renderInstalledPluginWorkspace } from './workspace/renderInstalledPluginWorkspace'
import { renderMarketplacePluginWorkspace } from './workspace/renderMarketplacePluginWorkspace'
import { renderPluginCatalogWorkspace } from './workspace/renderPluginCatalogWorkspace'

export function PluginsWorkspace(props: Parameters<typeof usePluginsWorkspaceController>[0]) {
  const key = JSON.stringify([
    pluginMarketplaceCacheKey(props.cloudApiBaseUrl, props.cloudToken),
    isDesktopRuntime() ? getKnownLocalExecutorDeviceId() : '',
  ])
  return <PluginsWorkspaceContent key={key} {...props} />
}
function PluginsWorkspaceContent(props: Parameters<typeof usePluginsWorkspaceController>[0]) {
  const state = usePluginsWorkspaceController(props)
  const view = { ...state, ...renderPluginWorkspaceDialogs(state) }
  if (state.selectedPlugin) return renderInstalledPluginWorkspace(view)
  if (state.selectedMarketplacePlugin) return renderMarketplacePluginWorkspace(view)
  return renderPluginCatalogWorkspace(view)
}
