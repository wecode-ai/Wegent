export interface LocalDeviceSkill {
  name: string
  description: string
  short_description?: string | null
  path: string
  source: 'claude' | 'codex' | string
  scope?: 'user' | 'system' | 'repo' | 'admin' | string
  source_label?: string | null
  source_priority?: number
  origin?: 'local' | 'wegent' | string
  plugin_name?: string | null
  plugin_provider?: string | null
  plugin_version?: string | null
  mtime?: number
}

export interface LocalDeviceApp {
  id: string
  name: string
  pluginKey?: string | null
  description?: string | null
  logoUrl?: string | null
  logoUrlDark?: string | null
  installUrl?: string | null
  isAccessible?: boolean
  isEnabled?: boolean
  pluginDisplayNames?: string[]
  source?: 'codex-app' | string
  skillPath?: string | null
  trialTemplates?: PluginPathComponent[]
}

export interface PluginPathComponent {
  name: string
  path: string
  description?: string | null
  category?: string | null
  canonicalConnectorId?: string | null
  logoUrl?: string | null
  logoUrlDark?: string | null
  materializedAppIds?: string[]
  unavailableReason?: string | null
}
