import type {
  InstalledPlugin,
  InstalledPluginComponents,
  PluginInterface,
} from './installed-plugin-types'
import type {
  CodexPluginMarketplaceEntry,
  CodexPluginSummary,
  CodexPluginConnector,
  CodexPluginDetail,
  WegentStorePluginSummary,
} from './codex-plugin-types'
import { isPersonalMarketplaceId } from './personal-plugin-identity'
import {
  INTERNAL_DEVICE_MARKETPLACE_ID,
  isInternalDeviceMarketplaceId,
  isOpenAiOfficialMarketplaceId,
  isWegentCloudMarketplaceId as isWegentCloudMarketplace,
} from './plugin-marketplace-identity'
export function normalizeMarketplaceSource(source: string): string {
  const normalized = source.trim().replace(/\\\\/g, '/')
  return normalized.replace(/(?:\/\.agents\/plugins)?\/marketplace\.json$/i, '')
}

export function isLocalMarketplacePath(path: string | null | undefined): boolean {
  if (!path) return false
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

export function emptyComponents(): InstalledPluginComponents {
  return {
    skills: [],
    commands: [],
    apps: [],
    agents: [],
    mcps: [],
    hooks: [],
    lsps: [],
    monitors: [],
    bins: [],
  }
}

export function pluginDescription(
  summary: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): string {
  return (
    detail?.description?.trim() ||
    summary.interface?.shortDescription?.trim() ||
    summary.interface?.longDescription?.trim() ||
    ''
  )
}

export function pluginDisplayName(summary: CodexPluginSummary): string {
  return summary.interface?.displayName?.trim() || summary.name
}

export function localMarketplaceSource(
  marketplace: CodexPluginMarketplaceEntry,
  translate: (key: string) => string
): {
  sourceProvider: 'wegent' | 'codex' | 'user'
  sourceLabel: string
  visibility: 'personal' | 'workspace' | 'public'
} {
  if (isPersonalMarketplaceId(marketplace.name)) {
    return {
      sourceProvider: 'user',
      sourceLabel: translate('workbench.plugins_source_personal_share'),
      visibility: 'personal',
    }
  }
  if (isInternalDeviceMarketplaceId(marketplace.name)) {
    return {
      sourceProvider: 'wegent',
      sourceLabel: translate('workbench.plugins_source_wegent_official'),
      visibility: 'workspace',
    }
  }
  if (isOpenAiOfficialMarketplaceId(marketplace.name)) {
    return {
      sourceProvider: 'codex',
      sourceLabel: translate('workbench.plugins_source_openai_official'),
      visibility: 'public',
    }
  }
  return {
    sourceProvider: 'codex',
    sourceLabel: marketplace.interface?.displayName?.trim() || marketplace.name,
    visibility: 'public',
  }
}

export function sourcePayload(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary
): Record<string, unknown> {
  return {
    marketplaceName: marketplace.name,
    marketplacePath: marketplace.path ?? null,
    pluginName: plugin.name,
    pluginId: plugin.id,
    remotePluginId: plugin.remotePluginId ?? null,
  }
}

export function pluginComponents(detail?: CodexPluginDetail | null): InstalledPluginComponents {
  const components = emptyComponents()
  if (!detail) return components
  components.skills = (detail.skills ?? []).map(skill => ({
    name: skill.name,
    description: skill.shortDescription || skill.description || '',
    path: skill.path || skill.name,
  }))
  components.hooks = (detail.hooks ?? []).map(hook => ({
    name: hook.key,
    path: hook.key,
  }))
  components.mcps = (detail.mcpServers ?? []).map(name => ({
    name,
    server: {},
  }))
  components.apps = (detail.apps ?? []).map(app => ({
    name: app.name,
    path: app.id,
    description: app.description ?? null,
  }))
  components.commands = [
    ...(detail.appTemplates ?? []).map(template => ({
      name: template.name,
      path: template.templateId,
      description: template.description ?? null,
      category: template.category ?? null,
      canonicalConnectorId: template.canonicalConnectorId ?? null,
      logoUrl: template.logoUrl ?? null,
      logoUrlDark: template.logoUrlDark ?? null,
      materializedAppIds: template.materializedAppIds ?? [],
      unavailableReason: template.reason ?? null,
    })),
  ]
  components.templates = components.commands
  const declaredConnectors = detail.connectors ?? []
  const inferredConnectors: CodexPluginConnector[] =
    declaredConnectors.length === 0 &&
    detail.summary.authPolicy?.trim().toLowerCase() === 'on_install'
      ? (detail.apps ?? [])
          .filter(app => app.required !== false)
          .map(app => ({
            slug:
              app.slug?.trim() ||
              app.name
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') ||
              detail.summary.name,
            authPolicy: 'on_install' as const,
          }))
      : []
  components.connectors = [...declaredConnectors, ...inferredConnectors].map(connector => {
    const localAuth = connector.localAuth
    return {
      slug: connector.slug,
      displayName: connector.displayName ?? null,
      authorizationGroup: connector.authorizationGroup ?? null,
      ...(connector.accountAuth ? { accountAuth: connector.accountAuth } : {}),
      authPolicy:
        connector.authPolicy === 'on_install' ||
        connector.authPolicy === 'on_use' ||
        connector.authPolicy === 'optional'
          ? connector.authPolicy
          : 'optional',
      description: connector.description ?? null,
      localAuth:
        localAuth?.health &&
        localAuth.start &&
        (localAuth.kind === 'browser_oauth' || localAuth.poll)
          ? {
              ...localAuth,
              health: localAuth.health,
              start: localAuth.start,
              poll: localAuth.poll ?? [],
            }
          : null,
    }
  })
  components.agents = (detail.agents ?? []).map(agent => ({
    name: agent.name,
    path: agent.path ?? agent.name,
    description: agent.description ?? null,
  }))
  return components
}

export function safeRelativePluginAssetPath(value: string): string | null {
  const segments = value.replace(/\\/g, '/').split('/')
  const safeSegments: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    safeSegments.push(segment)
  }
  return safeSegments.length > 0 ? safeSegments.join('/') : null
}

export function isRelativePluginAssetPath(value: string): boolean {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
}

export function localPluginRoot(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): string | null {
  if (marketplace.path && isLocalMarketplacePath(marketplace.path)) {
    const sourcePath =
      plugin.source && typeof plugin.source.path === 'string' ? plugin.source.path.trim() : ''
    if (sourcePath) {
      if (isLocalMarketplacePath(sourcePath)) return sourcePath.replace(/[\\/]+$/, '')
      const relativeSourcePath = safeRelativePluginAssetPath(sourcePath)
      if (relativeSourcePath) {
        return `${normalizeMarketplaceSource(marketplace.path).replace(/[\\/]+$/, '')}/${relativeSourcePath}`
      }
    }
  }

  for (const path of (detail?.skills ?? []).map(skill => skill.path)) {
    if (!path || !isLocalMarketplacePath(path)) continue
    const normalized = path.replace(/\\/g, '/')
    const skillsIndex = normalized.lastIndexOf('/skills/')
    if (skillsIndex > 0) return normalized.slice(0, skillsIndex)
  }
  return null
}

export type CodexPluginInterfaceAssets = PluginInterface & {
  logoUrl?: string | null
  logoUrlDark?: string | null
  composerIconUrl?: string | null
  screenshotUrls?: string[] | null
  homepageUrl?: string | null
  homepage?: string | null
  privacyPolicy?: string | null
  termsOfService?: string | null
}

export function firstPluginAssetUrl(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (value) return value
  }
  return null
}

export function normalizePluginInterfaceAssets(interfaceData: PluginInterface): PluginInterface {
  const raw = interfaceData as CodexPluginInterfaceAssets
  const screenshots =
    raw.screenshots && raw.screenshots.length > 0
      ? raw.screenshots
      : raw.screenshotUrls && raw.screenshotUrls.length > 0
        ? raw.screenshotUrls
        : raw.screenshots
  return {
    ...interfaceData,
    composerIcon: firstPluginAssetUrl(raw.composerIcon, raw.composerIconUrl),
    logo: firstPluginAssetUrl(raw.logo, raw.logoUrl),
    logoDark: firstPluginAssetUrl(raw.logoDark, raw.logoUrlDark),
    websiteUrl: firstPluginAssetUrl(raw.websiteUrl, raw.homepageUrl, raw.homepage),
    privacyPolicyUrl: firstPluginAssetUrl(raw.privacyPolicyUrl, raw.privacyPolicy),
    termsOfServiceUrl: firstPluginAssetUrl(raw.termsOfServiceUrl, raw.termsOfService),
    screenshots,
  }
}

export function resolvePluginInterfaceAssets(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): PluginInterface | null {
  const interfaceData = plugin.interface
  if (!interfaceData) return null
  const normalized = normalizePluginInterfaceAssets(interfaceData)
  const root = localPluginRoot(marketplace, plugin, detail)
  if (!root) return normalized
  const resolve = (value?: string | null): string | null | undefined => {
    const source = value?.trim()
    if (!source || !isRelativePluginAssetPath(source)) return value
    const relativePath = safeRelativePluginAssetPath(source)
    return relativePath ? `${root}/${relativePath}` : null
  }
  return {
    ...normalized,
    composerIcon: resolve(normalized.composerIcon),
    logo: resolve(normalized.logo),
    logoDark: resolve(normalized.logoDark),
    screenshots: normalized.screenshots?.map(screenshot => resolve(screenshot) || screenshot),
  }
}

export function installedPluginSummaryIdentity(
  marketplaceName: string,
  plugin: CodexPluginSummary
): string {
  const pluginKey = String(plugin.name || plugin.id || '')
    .trim()
    .toLowerCase()
  const marketplace = marketplaceName.trim().toLowerCase()
  return pluginKey && marketplace ? `${pluginKey}@${marketplace}` : ''
}

export function mergeInstalledPluginSummaries(
  installedMarketplaces: CodexPluginMarketplaceEntry[],
  availableMarketplaces: CodexPluginMarketplaceEntry[],
  translate: (key: string) => string
): InstalledPlugin[] {
  const merged = new Map<string, InstalledPlugin>()
  const add = (marketplace: CodexPluginMarketplaceEntry, plugin: CodexPluginSummary) => {
    const normalized: CodexPluginSummary = {
      ...plugin,
      id: plugin.id?.trim() || plugin.name,
      installed: true,
      // Missing enabled in installed summaries should not hide the plugin from composer.
      enabled: plugin.enabled !== false,
    }
    const identity =
      installedPluginSummaryIdentity(marketplace.name, normalized) ||
      `id:${normalized.id || normalized.name}`
    if (!merged.has(identity)) {
      merged.set(identity, toInstalledPlugin(marketplace, normalized, undefined, translate))
    }
  }

  for (const marketplace of installedMarketplaces) {
    for (const plugin of marketplace.plugins) {
      add(marketplace, plugin)
    }
  }
  for (const marketplace of availableMarketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!plugin.installed) continue
      add(marketplace, plugin)
    }
  }
  return Array.from(merged.values())
}

export function toWegentStoreInstalledPlugin(
  plugin: WegentStorePluginSummary,
  storePath: string,
  translate: (key: string) => string
): InstalledPlugin {
  const marketplace = isWegentCloudMarketplace(plugin.marketplace)
    ? INTERNAL_DEVICE_MARKETPLACE_ID
    : plugin.marketplace
  const installed = toInstalledPlugin(
    {
      name: marketplace,
      path: storePath || plugin.pluginPath,
      plugins: [],
    },
    {
      id: plugin.packageId,
      name: plugin.name,
      installed: true,
      enabled: plugin.enabled,
      localVersion: plugin.version ?? undefined,
      source: {
        source: 'local',
        path: plugin.pluginPath,
      },
      interface: {
        defaultPrompt: plugin.defaultPrompt,
        displayName: plugin.displayName?.trim() || plugin.name,
        shortDescription: plugin.description ?? null,
        logo: plugin.logo ?? null,
        category: plugin.category ?? null,
      },
    },
    undefined,
    translate
  )
  return {
    ...installed,
    spec: {
      ...installed.spec,
      source: {
        ...installed.spec.source,
        type: 'marketplace',
      },
      origin: 'market',
      sourcePayload: {
        ...(installed.spec.sourcePayload ?? {}),
        managedByWegent: true,
        cloudPluginId: plugin.cloudPluginId ?? null,
        cloudInstalledPluginId: plugin.installedPluginId ?? null,
      },
    },
  }
}

export function toInstalledPlugin(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail: CodexPluginDetail | null | undefined,
  translate: (key: string) => string
): InstalledPlugin {
  const components = pluginComponents(detail)
  const resolvedInterface = resolvePluginInterfaceAssets(marketplace, plugin, detail)
  const isCreated = isPersonalMarketplaceId(marketplace.name)
  const source = localMarketplaceSource(marketplace, translate)
  const skillStates = Object.fromEntries(
    (detail?.skills ?? []).map(skill => [`skill:${skill.name}`, skill.enabled])
  )
  const pluginId = plugin.id?.trim() || plugin.name
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: plugin.name,
      namespace: marketplace.name,
      labels: { id: pluginId },
    },
    spec: {
      source: {
        type: isCreated ? 'local' : 'marketplace',
        providerKey: marketplace.name,
        pluginKey: plugin.name,
        catalogItemId: plugin.remotePluginId ?? pluginId,
        marketplace: marketplace.name,
      },
      origin: isCreated ? 'created' : 'market',
      sourceProvider: source.sourceProvider,
      sourceLabel: source.sourceLabel,
      visibility: source.visibility,
      displayName: pluginDisplayName(plugin),
      description: pluginDescription(plugin, detail),
      version: plugin.localVersion ?? null,
      author: resolvedInterface?.developerName ?? null,
      installState: plugin.installed ? 'installed' : 'not_installed',
      enabled: plugin.enabled !== false,
      componentStates: skillStates,
      manifest: {
        name: plugin.name,
        id: pluginId,
        source: plugin.source ?? null,
        installPolicy: plugin.installPolicy ?? null,
        authPolicy: plugin.authPolicy ?? null,
        availability: plugin.availability ?? null,
        disabledReason: plugin.disabledReason ?? null,
        eligiblePlanTypes: plugin.eligiblePlanTypes ?? null,
      },
      components,
      interface: resolvedInterface,
      packageRef: null,
      sourcePayload: {
        ...sourcePayload(marketplace, plugin),
        localId: isCreated ? pluginId : null,
      },
    },
    status: { state: plugin.enabled !== false ? 'enabled' : 'disabled' },
  }
}
