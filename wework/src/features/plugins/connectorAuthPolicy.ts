import type { InstalledPluginComponents } from '@/types/api'

type Connector = NonNullable<InstalledPluginComponents['connectors']>[number]

/** Account connections are configured after installation in the account panel. */
export function requiresInstallConnectorAuth(connector: Connector): boolean {
  return connector.authPolicy === 'on_install' && !connector.accountAuth
}
