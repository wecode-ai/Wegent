/* eslint-disable react-refresh/only-export-components -- DSH route modules expose a preload hook. */
import { PluginsPage } from './PluginsPage'
import { prefetchPluginsWorkspace } from '@/components/plugins/workspace/prefetchPluginsWorkspace'

export function preload() {
  prefetchPluginsWorkspace()
}

export default function PluginCatalogRoute({ search = '' }: { search?: string }) {
  return <PluginsPage routeSearch={search} />
}
