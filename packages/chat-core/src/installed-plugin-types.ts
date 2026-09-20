import type { PluginPathComponent } from './runtime-composer-catalog'
export type PluginInstallState =
  | 'not_installed'
  | 'installed'
  | 'update_available'
  | 'unavailable'
  | 'failed'
  | 'uninstalled'

export interface PluginSkillComponent {
  name: string
  description: string
  path: string
}

export interface PluginMCPComponent {
  name: string
  server: Record<string, unknown>
}

export interface InstalledPluginComponents {
  skills: PluginSkillComponent[]
  commands: PluginPathComponent[]
  templates?: PluginPathComponent[]
  apps?: PluginPathComponent[]
  agents: PluginPathComponent[]
  hooks: PluginPathComponent[]
  mcps: PluginMCPComponent[]
  connectors?: Array<{
    slug: string
    displayName?: string | null
    authorizationGroup?: { id: string; displayName: string } | null
    authPolicy: 'on_install' | 'on_use' | 'optional'
    localAuth?: PluginLocalAuthDefinition | null
    accountAuth?: {
      protocolVersion: 1
      credentialType: 'password' | 'bearer' | 'oauth2'
      oauth2?: Array<'authorize' | 'refresh' | 'revoke'>
      exportMode?: 'exclusive'
      localEnvironment?: Record<string, { type: 'directory' } | { type: 'enum'; values: string[] }>
      adapter: string
    } | null
    description?: string | null
  }>
  lsps: PluginPathComponent[]
  monitors: PluginPathComponent[]
  bins: PluginPathComponent[]
  settings?: Record<string, unknown> | null
  workbench?: WorkbenchPluginComponent | null
}

export interface WorkbenchFrontendModule {
  entry: string
  export: string
  sha256: string
}

export interface WorkbenchDesktopSidecar {
  command: string
  args: string[]
  sha256: string
  capabilities: string[]
}

export interface WorkbenchPluginComponent {
  apiVersion: '1'
  required: boolean
  pinnedToClientVersion: boolean
  clientVersion?: string | null
  frontend?: WorkbenchFrontendModule | null
  desktop?: WorkbenchDesktopSidecar | null
}

export interface PluginLocalAuthDefinition {
  kind?: 'local_qr' | 'browser_oauth'
  health: string[]
  start: string[]
  poll: string[]
  logout?: string[]
  tool?: PluginLocalAuthToolDefinition | null
  qrField?: string
  statusField?: string
  okValues?: string[]
  pollIntervalSeconds?: number
  timeoutSeconds?: number
  logoutOnUninstall?: boolean
}

export interface PluginLocalAuthArtifactDefinition {
  url: string
  sha256: string
  archive: 'tar_gz' | 'zip'
  binaryPath: string
}

export interface PluginLocalAuthToolDefinition {
  id: string
  source: 'bundled' | 'managed'
  version?: string | null
  artifacts?: Record<string, PluginLocalAuthArtifactDefinition>
}

export interface InstalledPluginSource {
  type: 'upload' | 'marketplace' | 'local'
  providerKey: string
  pluginKey: string
  catalogItemId?: string | null
  marketplace?: string | null
}

export interface InstalledPluginPackageRef {
  storageKey: string
  checksum: string
  sizeBytes: number
}

export interface PluginInterface {
  displayName?: string | null
  shortDescription?: string | null
  longDescription?: string | null
  developerName?: string | null
  category?: string | null
  capabilities?: string[]
  websiteUrl?: string | null
  privacyPolicyUrl?: string | null
  termsOfServiceUrl?: string | null
  defaultPrompt?: string[] | null
  brandColor?: string | null
  composerIcon?: string | null
  logo?: string | null
  logoDark?: string | null
  screenshots?: string[]
}

export interface InstalledPlugin {
  apiVersion: string
  kind: 'InstalledPlugin'
  metadata: Record<string, unknown>
  spec: {
    source: InstalledPluginSource
    origin?: 'created' | 'market'
    pluginId?: number | null
    releaseId?: number | null
    desiredVersion?: string | null
    updatePolicy?: 'manual' | 'auto'
    sourceProvider?: 'wegent' | 'codex' | 'user'
    sourceLabel?: string
    visibility?: 'personal' | 'workspace' | 'public'
    displayName: string
    description: string
    version?: string | null
    author?: string | null
    installState: PluginInstallState
    enabled: boolean
    componentStates?: Record<string, boolean>
    manifest: Record<string, unknown>
    components: InstalledPluginComponents
    interface?: PluginInterface | null
    packageRef?: InstalledPluginPackageRef | null
    sourcePayload?: Record<string, unknown> | null
  }
  status: {
    state: string
    devices?: Array<{
      deviceId: string
      desiredReleaseId: number
      actualReleaseId?: number | null
      state: 'pending' | 'downloading' | 'installing' | 'installed' | 'failed' | 'uninstalling'
      errorCode?: string | null
      errorMessage?: string | null
      attemptCount: number
      lastSyncAt?: string | null
      updatedAt: string
    }>
  }
}
