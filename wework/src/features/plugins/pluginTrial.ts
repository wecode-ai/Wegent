import type { InstalledPlugin, PluginPathComponent } from '@/types/api'
import { resolvePluginLogoUrl } from '@/components/plugins/plugin-assets'
import { registerComposerMentionIcon } from '@/components/chat/composer/composerMentions'

const PLUGIN_TRIAL_STORAGE_KEY = 'wework:pending-plugin-trial'
export const PLUGIN_TRIAL_QUEUED_EVENT = 'wework:plugin-trial-queued'
export const LOCAL_PLUGIN_SKILLS_CHANGED_EVENT = 'wework:local-plugin-skills-changed'
export const FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT = 'wework:focus-plugin-trial-composer'
export const INSERT_PLUGIN_REFERENCE_EVENT = 'wework:insert-plugin-reference'
export const SHOW_PLUGIN_TRIAL_GUIDE_EVENT = 'wework:show-plugin-trial-guide'

export function insertPluginReference(reference: string) {
  window.dispatchEvent(
    new CustomEvent(INSERT_PLUGIN_REFERENCE_EVENT, {
      detail: { reference },
    })
  )
}

export function showPluginTrialGuide(
  pluginName: string,
  templates: PluginPathComponent[] | undefined
) {
  const normalizedName = pluginName.trim()
  const availableTemplates = (templates ?? []).filter(template => !template.unavailableReason)
  if (!normalizedName || availableTemplates.length === 0) return
  window.dispatchEvent(
    new CustomEvent(SHOW_PLUGIN_TRIAL_GUIDE_EVENT, {
      detail: {
        pluginName: normalizedName,
        templates: availableTemplates.slice(0, 6),
      },
    })
  )
}

interface PendingPluginTrial {
  input: string
  pluginName: string
  templates: PluginPathComponent[]
}

interface PluginReferenceTrial {
  pluginName: string
  marketplaceName: string
  displayName: string
  templates?: PluginPathComponent[]
}

function queuePendingPluginTrial(payload: PendingPluginTrial): boolean {
  window.sessionStorage.setItem(PLUGIN_TRIAL_STORAGE_KEY, JSON.stringify(payload))
  window.dispatchEvent(new Event(PLUGIN_TRIAL_QUEUED_EVENT))
  return true
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
    plugin.spec.source.marketplace ||
    plugin.metadata.namespace
  if (typeof pluginName !== 'string' || !pluginName.trim()) return null
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) return null
  return `plugin://${pluginName}@${marketplaceName}`
}

function registerPluginMentionIcon(plugin: InstalledPlugin, reference: string): void {
  const pluginKey =
    plugin.spec.source.pluginKey ||
    (typeof plugin.metadata.name === 'string' ? plugin.metadata.name : null)
  registerComposerMentionIcon(
    reference,
    resolvePluginLogoUrl({
      pluginKey,
      logo: plugin.spec.interface?.logo,
      composerIcon: plugin.spec.interface?.composerIcon,
    })
  )
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

function defaultPromptTemplates(plugin: InstalledPlugin): PluginPathComponent[] {
  const raw = plugin.spec.interface?.defaultPrompt
  const prompts = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
    .filter((prompt): prompt is string => typeof prompt === 'string' && Boolean(prompt.trim()))
    .map(prompt => prompt.trim())
  const pluginName = plugin.spec.displayName || plugin.spec.source.pluginKey || 'this plugin'
  const guidePrompts =
    prompts.length > 0
      ? prompts
      : [
          `Use ${pluginName} to summarize the current context and propose next steps`,
          `Use ${pluginName} to create an editable result from the current materials`,
          `Use ${pluginName} to inspect the current work and identify issues`,
        ]
  return guidePrompts.map((prompt, index) => ({
    name: prompt,
    path: `prompt-${index}`,
    description: prompt,
  }))
}

export function pluginTrialTemplates(
  plugin: InstalledPlugin,
  selectedPrompt?: string
): PluginPathComponent[] {
  const nativeTemplates = (
    plugin.spec.components.templates ??
    plugin.spec.components.commands ??
    []
  ).filter(template => !template.unavailableReason)
  const templates = nativeTemplates.length > 0 ? nativeTemplates : defaultPromptTemplates(plugin)
  const normalizedSelectedPrompt = selectedPrompt?.trim()
  if (!normalizedSelectedPrompt) return templates

  const selectedTitle = normalizedSelectedPrompt.split(/\r?\n/, 1)[0].trim()
  if (selectedTitle !== normalizedSelectedPrompt) {
    return [
      {
        name: selectedTitle,
        path: 'selected-use-case',
        description: normalizedSelectedPrompt,
      },
      ...templates.filter(
        template =>
          template.name.trim() !== selectedTitle && template.description?.trim() !== selectedTitle
      ),
    ]
  }

  const selectedIndex = templates.findIndex(
    template =>
      template.description?.trim() === normalizedSelectedPrompt ||
      template.name.trim() === normalizedSelectedPrompt
  )
  if (selectedIndex < 0) {
    return [
      {
        name: normalizedSelectedPrompt,
        path: 'selected-use-case',
        description: normalizedSelectedPrompt,
      },
      ...templates,
    ]
  }
  return [templates[selectedIndex], ...templates.filter((_, index) => index !== selectedIndex)]
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
  registerPluginMentionIcon(plugin, reference)
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
  return queuePendingPluginTrial({
    input,
    pluginName: plugin.spec.displayName || plugin.spec.source.pluginKey,
    templates: pluginTrialTemplates(plugin),
  })
}

export function queuePluginPromptTrial(plugin: InstalledPlugin, prompt: string): boolean {
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
  })
}

export function queuePluginReferenceTrial({
  pluginName,
  marketplaceName,
  displayName,
  templates = [],
}: PluginReferenceTrial): boolean {
  const normalizedPluginName = pluginName.trim()
  const normalizedMarketplaceName = marketplaceName.trim()
  const normalizedDisplayName = displayName.trim()
  if (!normalizedPluginName || !normalizedMarketplaceName || !normalizedDisplayName) return false

  return queuePendingPluginTrial({
    input: `[$${normalizedDisplayName}](plugin://${normalizedPluginName}@${normalizedMarketplaceName}) `,
    pluginName: normalizedDisplayName,
    templates,
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

const PLUGIN_USAGE_STORAGE_KEY = 'wework:plugin-usage-30d'
const TRIAL_GUIDE_DISMISSED_KEY = 'wework:dismissed-trial-guide'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function normalizePluginKey(pluginName: string): string {
  return pluginName.trim().toLowerCase()
}

function readUsageMap(): Record<string, number[]> {
  try {
    const raw = window.localStorage.getItem(PLUGIN_USAGE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        Array.isArray(value) && value.every(item => typeof item === 'number')
          ? [[key, value as number[]]]
          : []
      )
    )
  } catch {
    return {}
  }
}

function writeUsageMap(map: Record<string, number[]>): void {
  window.localStorage.setItem(PLUGIN_USAGE_STORAGE_KEY, JSON.stringify(map))
}

export function getPluginUseCount30d(pluginName: string): number {
  const key = normalizePluginKey(pluginName)
  if (!key) return 0
  const cutoff = Date.now() - THIRTY_DAYS_MS
  return (readUsageMap()[key] ?? []).filter(timestamp => timestamp >= cutoff).length
}

export function recordPluginUsage(pluginName: string): void {
  const key = normalizePluginKey(pluginName)
  if (!key) return
  const map = readUsageMap()
  const cutoff = Date.now() - THIRTY_DAYS_MS
  map[key] = [...(map[key] ?? []).filter(timestamp => timestamp >= cutoff), Date.now()]
  writeUsageMap(map)
}

const PLUGIN_MENTION_PATTERN = /\[\$([^\]]+)\]\((plugin:\/\/[^)]+)\)/g

export function recordPluginUsageFromInput(input: string): void {
  const seen = new Set<string>()
  for (const match of input.matchAll(PLUGIN_MENTION_PATTERN)) {
    const pluginName = match[1]?.trim()
    if (!pluginName || seen.has(pluginName)) continue
    seen.add(pluginName)
    recordPluginUsage(pluginName)
  }
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

export function buildTrialTemplatePrompt(
  currentInput: string,
  template: PluginPathComponent
): string {
  const mentionMatch = currentInput.match(/^(\[\$[^\]]+\]\([^)]+\))\s*/)
  const prefix = mentionMatch?.[1] ?? ''
  const templateText = template.description?.trim() || template.name.trim()
  return prefix ? `${prefix} ${templateText} ` : `${templateText} `
}

export function buildContextualPluginPrompt(
  currentInput: string,
  instruction: string,
  currentIdeaLabel: string
): string {
  const mentionMatch = currentInput.match(/^(\[\$[^\]]+\]\([^)]+\))\s*/)
  const prefix = mentionMatch?.[1] ?? ''
  const currentIdea = mentionMatch
    ? currentInput.slice(mentionMatch[0].length).trim()
    : currentInput.trim()
  const body = [instruction.trim()]
  if (currentIdea) body.push(`${currentIdeaLabel.trim()}: ${currentIdea}`)
  const prompt = body.filter(Boolean).join('\n\n')
  return prefix ? `${prefix} ${prompt} ` : `${prompt} `
}
