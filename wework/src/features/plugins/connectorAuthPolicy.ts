import type { InstalledPluginComponents } from '@/types/api'

type Connector = NonNullable<InstalledPluginComponents['connectors']>[number]

/** Bearer snapshots share their source login; managed account flows stay separate. */
export function requiresInstallConnectorAuth(connector: Connector): boolean {
  const localSnapshot =
    connector.accountAuth?.credentialType === 'bearer' && Boolean(connector.localAuth)
  return connector.authPolicy === 'on_install' && (!connector.accountAuth || localSnapshot)
}
