import { beginOperation } from '@/telemetry/operationBus'
import { getPluginUseCount30d } from '@wegent/collaboration/composer/pluginUsage'
export {
  getPluginUseCount30d,
  recordPluginUsage,
  recordPluginUsageFromInput,
} from '@wegent/collaboration/composer/pluginUsage'
import { pluginTrialTemplates } from '@wegent/chat-core/plugin-trial-templates'
export { pluginTrialTemplates } from '@wegent/chat-core/plugin-trial-templates'
import type {
  InstalledPlugin,
  LocalDeviceApp,
  PluginPathComponent,
  ProjectWithTasks,
} from '@/types/api'
import {
  currentPluginLogoAppearanceMode,
  resolveInstalledPluginLogoUrl,
  resolvePluginLogo,
} from '@/components/plugins/plugin-assets'
import {
  getComposerApps,
  removeComposerAppsByPluginIdentity,
} from '@/components/chat/composer/composerAppsSnapshot'
import { registerComposerMentionIcon } from '@/components/chat/composer/composerMentions'
import { composerAppPluginKey } from './composerPluginMetadata'
import { managedMarketplaceName } from './pluginMarketplaceIdentity'

const PLUGIN_TRIAL_STORAGE_KEY = 'wework:pending-plugin-trial'
export const PLUGIN_TRIAL_QUEUED_EVENT = 'wework:plugin-trial-queued'
export const LOCAL_PLUGIN_SKILLS_CHANGED_EVENT = 'wework:local-plugin-skills-changed'
export const FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT = 'wework:focus-plugin-trial-composer'

interface PendingPluginTrial {
  input: string
  pluginName: string
  templates: PluginPathComponent[]
  app?: LocalDeviceApp
  openInNewChat?: boolean
  targetProject?: ProjectWithTasks
  targetWorkspace?: {
    deviceId: string
    path: string
  }
}

interface PluginReferenceTrial {
  pluginName: string
  marketplaceName: string
  displayName: string
  templates?: PluginPathComponent[]
  prompt?: string
  openInNewChat?: boolean
  targetProject?: ProjectWithTasks
  targetWorkspace?: {
    deviceId: string
    path: string
  }
}

interface PluginTrialOptions {
  prompt?: string
  openInNewChat?: boolean
  reference?: PluginReferenceTrial
}

function queuePendingPluginTrial(payload: PendingPluginTrial): boolean {
  const attempt = beginOperation('plugin.trial')
  try {
    window.sessionStorage.setItem(PLUGIN_TRIAL_STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    attempt.fail('request')
    throw error
  }
  attempt.succeed()
  window.dispatchEvent(new Event(PLUGIN_TRIAL_QUEUED_EVENT))
  return true
}

function firstPluginSkill(plugin: InstalledPlugin) {
  const skills = Array.isArray(plugin.spec.components?.skills) ? plugin.spec.components.skills : []
  return skills.find(skill => skill.path && skill.name)
}

function sourcePayload(plugin: InstalledPlugin): Record<string, unknown> {
  const payload = plugin.spec.sourcePayload
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function pluginMentionPath(plugin: InstalledPlugin): string | null {
  const payload = sourcePayload(plugin)
  const metadataNamespace =
    typeof plugin.metadata.namespace === 'string' ? plugin.metadata.namespace : null
  const pluginName =
    (typeof payload.pluginName === 'string' && payload.pluginName.trim()) ||
    (typeof payload.remotePluginId === 'string' && payload.remotePluginId.trim()) ||
    plugin.spec.source?.pluginKey
  const marketplaceName =
    (typeof payload.marketplaceName === 'string' && payload.marketplaceName.trim()) ||
    managedMarketplaceName(plugin) ||
    plugin.spec.source?.marketplace ||
    (metadataNamespace && metadataNamespace !== 'default' ? metadataNamespace : null)
  if (typeof pluginName !== 'string' || !pluginName.trim()) return null
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) return null
  return `plugin://${pluginName}@${marketplaceName}`
}

function composerAppForPlugin(plugin: InstalledPlugin): LocalDeviceApp | null {
  const rawPluginKey = plugin.spec.source.pluginKey
  const rawMetadataName = typeof plugin.metadata.name === 'string' ? plugin.metadata.name : ''
  const pluginKey = (rawPluginKey || rawMetadataName).trim().toLowerCase()
  const displayName = (plugin.spec.displayName || '').trim().toLowerCase()
  if (!pluginKey && !displayName) return null
  const apps = getComposerApps()
  return (
    apps.find(app => composerAppPluginKey(app).trim().toLowerCase() === pluginKey) ||
    apps.find(app => (app.pluginKey || '').trim().toLowerCase() === pluginKey) ||
    apps.find(app => app.name.trim().toLowerCase() === displayName) ||
    null
  )
}

function registerMentionIconFromResolved(
  reference: string,
  logo: { url: string; source: string; contrastPad: boolean }
): void {
  if (logo.source !== 'provided' || !logo.url) return
  registerComposerMentionIcon(reference, {
    url: logo.url,
    contrastPad: logo.contrastPad,
  })
}

function registerPluginMentionIcon(plugin: InstalledPlugin, reference: string): void {
  const pluginKey =
    plugin.spec.source.pluginKey ||
    (typeof plugin.metadata.name === 'string' ? plugin.metadata.name : null)
  const packageLogo = resolvePluginLogo({
    pluginKey,
    logo: plugin.spec.interface?.logo,
    logoDark: plugin.spec.interface?.logoDark,
    composerIcon: plugin.spec.interface?.composerIcon,
    appearanceMode: currentPluginLogoAppearanceMode(),
  })
  if (packageLogo.source === 'provided' && packageLogo.url) {
    registerMentionIconFromResolved(reference, packageLogo)
    return
  }

  // Connectors often only expose icon_url on the composer app inventory.
  const composerApp = composerAppForPlugin(plugin)
  if (!composerApp) return
  registerMentionIconFromResolved(
    reference,
    resolvePluginLogo({
      pluginKey: composerAppPluginKey(composerApp),
      logo: composerApp.logoUrl,
      logoDark: composerApp.logoUrlDark,
      appearanceMode: currentPluginLogoAppearanceMode(),
    })
  )
}

function pluginTrialApp(plugin: InstalledPlugin): LocalDeviceApp {
  const pluginKey = plugin.spec.source.pluginKey
  const name = plugin.spec.displayName || pluginKey
  const composerApp = composerAppForPlugin(plugin)
  const packageLight = resolveInstalledPluginLogoUrl(plugin, 'light') || null
  const packageDark = resolveInstalledPluginLogoUrl(plugin, 'dark') || null
  return {
    id: `plugin:${pluginKey}`,
    name,
    pluginKey,
    logoUrl: packageLight || composerApp?.logoUrl || null,
    logoUrlDark: packageDark || composerApp?.logoUrlDark || null,
    source: 'installed-plugin',
  }
}

function skillFilePath(path: string): string {
  return path.endsWith('/SKILL.md') ? path : `${path.replace(/\/+$/, '')}/SKILL.md`
}

function firstDefaultPrompt(value: unknown): string | null {
  if (typeof value === 'string') {
    const prompt = value.trim()
    return prompt || null
  }
  if (Array.isArray(value)) {
    const prompt = value.find(item => typeof item === 'string' && item.trim())
    return typeof prompt === 'string' ? prompt.trim() : null
  }
  return null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function pluginTrialInput(
  plugin: InstalledPlugin,
  options: PluginTrialOptions = {}
): string | null {
  const skill = firstPluginSkill(plugin)
  const pluginPath = pluginMentionPath(plugin)
  const pluginName = plugin.spec.displayName || plugin.spec.source.pluginKey
  const referenceOverride = options.reference
  const reference =
    referenceOverride &&
    referenceOverride.pluginName.trim() &&
    referenceOverride.marketplaceName.trim() &&
    referenceOverride.displayName.trim()
      ? `[$${referenceOverride.displayName.trim()}](plugin://${referenceOverride.pluginName.trim()}@${referenceOverride.marketplaceName.trim()})`
      : pluginPath && pluginName
        ? `[$${pluginName}](${pluginPath})`
        : skill
          ? `[$${skill.name}](${skillFilePath(skill.path)})`
          : null
  if (!reference) return null
  registerPluginMentionIcon(plugin, reference)
  const promptOverride = options.prompt?.trim()
  const defaultPrompt = promptOverride || firstDefaultPrompt(plugin.spec.interface?.defaultPrompt)
  if (!defaultPrompt) return `${reference} `

  const skillTokenPattern = skill ? new RegExp(`\\$${escapeRegExp(skill.name)}\\b`, 'g') : null
  if (!skillTokenPattern) return `${reference} ${defaultPrompt}`
  const promptWithReference = defaultPrompt.replace(skillTokenPattern, reference)
  if (promptWithReference !== defaultPrompt) return `${promptWithReference} `

  return `${reference} ${defaultPrompt}`
}

export function queuePluginTrial(
  plugin: InstalledPlugin,
  options: PluginTrialOptions = {}
): boolean {
  const input = pluginTrialInput(plugin, options)
  if (!input) return false
  return queuePendingPluginTrial({
    input,
    pluginName: plugin.spec.displayName || plugin.spec.source.pluginKey,
    templates: pluginTrialTemplates(plugin, options.prompt),
    app: pluginTrialApp(plugin),
    openInNewChat: options.openInNewChat === true,
  })
}

export function queuePluginPromptTrial(
  plugin: InstalledPlugin,
  prompt: string,
  { openInNewChat = false }: PluginTrialOptions = {}
): boolean {
  const pluginPath = pluginMentionPath(plugin)
  const pluginName = plugin.spec.displayName || plugin.spec.source.pluginKey
  const normalizedPrompt = prompt.trim()
  if (!pluginPath || !pluginName || !normalizedPrompt) return false
  const reference = `[$${pluginName}](${pluginPath})`
  registerPluginMentionIcon(plugin, reference)
  return queuePendingPluginTrial({
    input: `${reference} ${normalizedPrompt}`,
    pluginName,
    templates: pluginTrialTemplates(plugin, normalizedPrompt),
    app: pluginTrialApp(plugin),
    openInNewChat,
  })
}

export function queuePluginInputTrial(
  plugin: InstalledPlugin,
  input: string,
  { openInNewChat = false, prompt }: PluginTrialOptions = {}
): boolean {
  const pluginName = plugin.spec.displayName || plugin.spec.source.pluginKey
  const normalizedInput = input.trim()
  if (!pluginName || !normalizedInput) return false
  return queuePendingPluginTrial({
    input: normalizedInput,
    pluginName,
    templates: pluginTrialTemplates(plugin, prompt ?? normalizedInput),
    openInNewChat,
  })
}

export function queuePluginReferenceTrial({
  pluginName,
  marketplaceName,
  displayName,
  templates = [],
  prompt,
  openInNewChat = false,
  targetProject,
  targetWorkspace,
}: PluginReferenceTrial): boolean {
  const normalizedPluginName = pluginName.trim()
  const normalizedMarketplaceName = marketplaceName.trim()
  const normalizedDisplayName = displayName.trim()
  if (!normalizedPluginName || !normalizedMarketplaceName || !normalizedDisplayName) return false
  const normalizedPrompt = prompt?.trim()
  const reference = `[$${normalizedDisplayName}](plugin://${normalizedPluginName}@${normalizedMarketplaceName})`

  return queuePendingPluginTrial({
    input: normalizedPrompt ? `${reference} ${normalizedPrompt}` : `${reference} `,
    pluginName: normalizedDisplayName,
    templates,
    openInNewChat,
    targetProject,
    targetWorkspace,
  })
}

export function consumePluginTrial(): PendingPluginTrial | null {
  const raw = window.sessionStorage.getItem(PLUGIN_TRIAL_STORAGE_KEY)
  if (!raw) return null
  window.sessionStorage.removeItem(PLUGIN_TRIAL_STORAGE_KEY)
  try {
    const payload = JSON.parse(raw) as Partial<PendingPluginTrial>
    if (typeof payload.input !== 'string' || !payload.input.trim()) return null
    return {
      input: payload.input,
      pluginName: typeof payload.pluginName === 'string' ? payload.pluginName : '',
      templates: Array.isArray(payload.templates) ? payload.templates : [],
      app:
        payload.app &&
        typeof payload.app === 'object' &&
        typeof payload.app.id === 'string' &&
        typeof payload.app.name === 'string'
          ? payload.app
          : undefined,
      openInNewChat: payload.openInNewChat === true,
      targetProject:
        payload.targetProject &&
        typeof payload.targetProject === 'object' &&
        typeof payload.targetProject.id === 'number' &&
        typeof payload.targetProject.name === 'string'
          ? (payload.targetProject as ProjectWithTasks)
          : undefined,
      targetWorkspace:
        payload.targetWorkspace &&
        typeof payload.targetWorkspace === 'object' &&
        typeof payload.targetWorkspace.deviceId === 'string' &&
        payload.targetWorkspace.deviceId.trim() &&
        typeof payload.targetWorkspace.path === 'string' &&
        payload.targetWorkspace.path.trim()
          ? {
              deviceId: payload.targetWorkspace.deviceId.trim(),
              path: payload.targetWorkspace.path.trim(),
            }
          : undefined,
    }
  } catch {
    return null
  }
}

export function consumePluginTrialInput(): string | null {
  return consumePluginTrial()?.input ?? null
}

export function notifyLocalPluginSkillsChanged(removedPluginIdentities: readonly string[] = []) {
  removeComposerAppsByPluginIdentity(removedPluginIdentities)
  window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
}

const TRIAL_GUIDE_DISMISSED_KEY = 'wework:dismissed-trial-guide'
function normalizePluginKey(pluginName: string): string {
  return pluginName.trim().toLowerCase()
}

function dismissedGuideKey(pluginName: string, scopeKey: string): string {
  return `${scopeKey}:${normalizePluginKey(pluginName)}`
}

function readDismissedGuides(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(TRIAL_GUIDE_DISMISSED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDismissedGuides(keys: Set<string>): void {
  window.sessionStorage.setItem(TRIAL_GUIDE_DISMISSED_KEY, JSON.stringify([...keys]))
}

export function isTrialGuideDismissed(pluginName: string, scopeKey: string): boolean {
  return readDismissedGuides().has(dismissedGuideKey(pluginName, scopeKey))
}

export function dismissTrialGuide(pluginName: string, scopeKey: string): void {
  const key = normalizePluginKey(pluginName)
  if (!key) return
  const next = readDismissedGuides()
  next.add(dismissedGuideKey(pluginName, scopeKey))
  writeDismissedGuides(next)
}

export function shouldShowPluginTrialGuide(pluginName: string, scopeKey: string): boolean {
  const key = normalizePluginKey(pluginName)
  if (!key) return false
  return getPluginUseCount30d(pluginName) === 0 && !isTrialGuideDismissed(pluginName, scopeKey)
}

export {
  buildTrialTemplatePrompt,
  buildContextualPluginPrompt,
  buildRefinedPluginPrompt,
} from '@wegent/chat-core/composer-plugin-trial'
