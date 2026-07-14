import type { InstalledPlugin, PluginPathComponent } from '@/types/api'

const PLUGIN_TRIAL_STORAGE_KEY = 'wework:pending-plugin-trial'
export const PLUGIN_TRIAL_QUEUED_EVENT = 'wework:plugin-trial-queued'
export const LOCAL_PLUGIN_SKILLS_CHANGED_EVENT = 'wework:local-plugin-skills-changed'
export const FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT = 'wework:focus-plugin-trial-composer'

interface PendingPluginTrial {
  input: string
  pluginName: string
  templates: PluginPathComponent[]
}

function firstPluginSkill(plugin: InstalledPlugin) {
  return plugin.spec.components.skills.find(skill => skill.path && skill.name)
}

function sourcePayload(plugin: InstalledPlugin): Record<string, unknown> {
  const payload = plugin.spec.sourcePayload
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function pluginMentionPath(plugin: InstalledPlugin): string | null {
  const payload = sourcePayload(plugin)
  const pluginName =
    (typeof payload.pluginName === 'string' && payload.pluginName.trim()) ||
    (typeof payload.remotePluginId === 'string' && payload.remotePluginId.trim()) ||
    plugin.spec.source.pluginKey
  const marketplaceName =
    (typeof payload.marketplaceName === 'string' && payload.marketplaceName.trim()) ||
    plugin.metadata.namespace
  if (typeof pluginName !== 'string' || !pluginName.trim()) return null
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) return null
  return `plugin://${pluginName}@${marketplaceName}`
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

export function pluginTrialInput(plugin: InstalledPlugin): string | null {
  const skill = firstPluginSkill(plugin)
  const pluginPath = pluginMentionPath(plugin)
  const pluginName = plugin.spec.displayName || plugin.spec.source.pluginKey
  const reference =
    pluginPath && pluginName
      ? `[$${pluginName}](${pluginPath})`
      : skill
        ? `[$${skill.name}](${skillFilePath(skill.path)})`
        : null
  if (!reference) return null
  const defaultPrompt = firstDefaultPrompt(plugin.spec.interface?.defaultPrompt)
  if (!defaultPrompt) return `${reference} `

  const skillTokenPattern = skill ? new RegExp(`\\$${escapeRegExp(skill.name)}\\b`, 'g') : null
  if (!skillTokenPattern) return `${reference} ${defaultPrompt}`
  const promptWithReference = defaultPrompt.replace(skillTokenPattern, reference)
  if (promptWithReference !== defaultPrompt) return `${promptWithReference} `

  return `${reference} ${defaultPrompt}`
}

export function queuePluginTrial(plugin: InstalledPlugin): boolean {
  const input = pluginTrialInput(plugin)
  if (!input) return false
  const payload: PendingPluginTrial = {
    input,
    pluginName: plugin.spec.displayName || plugin.spec.source.pluginKey,
    templates: plugin.spec.components.templates ?? plugin.spec.components.commands ?? [],
  }
  window.sessionStorage.setItem(PLUGIN_TRIAL_STORAGE_KEY, JSON.stringify(payload))
  window.dispatchEvent(new Event(PLUGIN_TRIAL_QUEUED_EVENT))
  return true
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
    }
  } catch {
    return null
  }
}

export function consumePluginTrialInput(): string | null {
  return consumePluginTrial()?.input ?? null
}

export function notifyLocalPluginSkillsChanged() {
  window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
}
