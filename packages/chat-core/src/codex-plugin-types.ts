import type { InstalledPluginComponents, PluginInterface } from './installed-plugin-types'
export interface CodexPluginMarketplaceEntry {
  name: string
  path?: string | null
  interface?: {
    displayName?: string | null
  } | null
  plugins: CodexPluginSummary[]
}

export interface CodexPluginSummary {
  id: string
  remotePluginId?: string | null
  localVersion?: string | null
  name: string
  source?: Record<string, unknown>
  installed: boolean
  enabled: boolean
  installPolicy?: string
  authPolicy?: string
  /** Codex PluginAvailability: AVAILABLE | DISABLED_BY_ADMIN */
  availability?: string
  /** Remote catalog reason, e.g. plan_not_eligible */
  disabledReason?: string | null
  eligiblePlanTypes?: string[] | null
  interface?: PluginInterface | null
  keywords?: string[]
}

export interface CodexPluginConnector {
  slug: string
  accountAuth?: NonNullable<InstalledPluginComponents['connectors']>[number]['accountAuth']
  displayName?: string | null
  authorizationGroup?: { id: string; displayName: string } | null
  authPolicy?: 'on_install' | 'on_use' | 'optional' | string | null
  localAuth?: {
    kind?: 'local_qr' | 'browser_oauth'
    health?: string[]
    start?: string[]
    poll?: string[]
    logout?: string[]
    tool?: {
      id: string
      source: 'bundled' | 'managed'
      version?: string | null
      artifacts?: Record<
        string,
        {
          url: string
          sha256: string
          archive: 'tar_gz' | 'zip'
          binaryPath: string
        }
      >
    } | null
    qrField?: string
    statusField?: string
    okValues?: string[]
    pollIntervalSeconds?: number
    timeoutSeconds?: number
    logoutOnUninstall?: boolean
  } | null
  description?: string | null
}

export interface CodexPluginDetail {
  marketplaceName: string
  marketplacePath?: string | null
  summary: CodexPluginSummary
  description?: string | null
  skills?: Array<{
    name: string
    description?: string | null
    shortDescription?: string | null
    path?: string | null
    enabled: boolean
  }>
  hooks?: Array<{ key: string; eventName?: string }>
  apps?: Array<{
    id: string
    name: string
    slug?: string | null
    required?: boolean | null
    description?: string | null
  }>
  appTemplates?: Array<{
    templateId: string
    name: string
    description?: string | null
    category?: string | null
    canonicalConnectorId?: string | null
    logoUrl?: string | null
    logoUrlDark?: string | null
    materializedAppIds?: string[]
    reason?: string | null
  }>
  agents?: Array<{
    name: string
    path?: string | null
    description?: string | null
  }>
  mcpServers?: string[]
  connectors?: CodexPluginConnector[]
}

export type WegentStorePluginSummary = {
  defaultPrompt?: PluginInterface['defaultPrompt']
  name: string
  packageId: string
  installedPluginId?: number | null
  marketplace: string
  version?: string | null
  enabled: boolean
  displayName?: string | null
  description?: string | null
  logo?: string | null
  category?: string | null
  pluginPath: string
}

export type WegentStoreListResult = {
  supportsPluginReconciliation?: boolean
  storePath: string
  plugins: WegentStorePluginSummary[]
}
