import { isLocalConnector, localConnectorAuthLogout } from '@/api/local/localConnectorAuth'
import type { InstalledPlugin } from '@/types/api'

/**
 * Best-effort logout for connectors that explicitly request uninstall cleanup.
 * Failures are swallowed so uninstall can continue.
 */
export async function logoutLocalConnectorsForPlugin(plugin: InstalledPlugin): Promise<void> {
  const connectors = (plugin.spec.components.connectors ?? []).filter(
    connector =>
      isLocalConnector(connector) &&
      (connector.localAuth?.logoutOnUninstall ?? connector.localAuth?.kind === 'local_qr')
  )
  if (connectors.length === 0) return

  const pluginKey = plugin.spec.source.pluginKey
  await Promise.allSettled(
    connectors.map(connector =>
      localConnectorAuthLogout({
        pluginKey,
        connectorSlug: connector.slug,
        localAuth: connector.localAuth ?? null,
      })
    )
  )
}
