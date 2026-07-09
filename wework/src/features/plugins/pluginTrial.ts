import type { InstalledPlugin } from '@/types/api'

const PLUGIN_TRIAL_STORAGE_KEY = 'wework:pending-plugin-trial'
export const LOCAL_PLUGIN_SKILLS_CHANGED_EVENT = 'wework:local-plugin-skills-changed'
export const FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT = 'wework:focus-plugin-trial-composer'

interface PendingPluginTrial {
  input: string
  pluginName: string
}

function firstPluginSkill(plugin: InstalledPlugin) {
  return plugin.spec.components.skills.find(skill => skill.path && skill.name)
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
  if (!skill) return null
  const reference = `[$${skill.name}](skill://${skillFilePath(skill.path)})`
  const defaultPrompt = firstDefaultPrompt(plugin.spec.interface?.defaultPrompt)
  if (!defaultPrompt) return `${reference} `

  const skillTokenPattern = new RegExp(`\\$${escapeRegExp(skill.name)}\\b`, 'g')
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
  }
  window.sessionStorage.setItem(PLUGIN_TRIAL_STORAGE_KEY, JSON.stringify(payload))
  return true
}

export function consumePluginTrialInput(): string | null {
  const raw = window.sessionStorage.getItem(PLUGIN_TRIAL_STORAGE_KEY)
  if (!raw) return null
  window.sessionStorage.removeItem(PLUGIN_TRIAL_STORAGE_KEY)
  try {
    const payload = JSON.parse(raw) as Partial<PendingPluginTrial>
    return typeof payload.input === 'string' && payload.input.trim() ? payload.input : null
  } catch {
    return null
  }
}

export function notifyLocalPluginSkillsChanged() {
  window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
}
