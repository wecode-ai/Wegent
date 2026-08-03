import { isLocalQrConnector, localConnectorAuthLogout } from '@/api/local/localConnectorAuth'
import type { InstalledPlugin } from '@/types/api'

/**
 * Best-effort logout for every local_qr connector on an installed plugin.
 * Failures are swallowed so uninstall can continue.
 */
export async function logoutLocalQrConnectorsForPlugin(plugin: InstalledPlugin): Promise<void> {
  const connectors = (plugin.spec.components.connectors ?? []).filter(connector =>
    isLocalQrConnector(connector)
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
