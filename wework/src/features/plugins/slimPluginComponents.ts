import type { InstalledPluginComponents } from '@/types/api'

export function emptyPluginComponents(): InstalledPluginComponents {
  return {
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcps: [],
    lsps: [],
    monitors: [],
    bins: [],
    connectors: [],
  }
}

/**
 * Keep skill / app / connector names for plugin detail paint after restart.
 * Drop filesystem paths and other heavy payloads so localStorage stays small.
 */
export function slimPluginComponentsForCache(
  components?: InstalledPluginComponents | null
): InstalledPluginComponents {
  const source = components ?? emptyPluginComponents()
  return {
    ...emptyPluginComponents(),
    skills: (source.skills ?? []).map(skill => ({
      name: skill.name,
      description: skill.description || '',
      path: skill.name,
    })),
    apps: (source.apps ?? []).map(app => ({
      name: app.name,
      path: app.path,
      description: app.description ?? null,
    })),
    connectors: (source.connectors ?? []).map(connector => ({
      slug: connector.slug,
      authPolicy: connector.authPolicy,
      localAuth: connector.localAuth ?? null,
      description: connector.description ?? null,
    })),
  }
}
