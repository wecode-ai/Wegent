import type { LocalDeviceApp, PluginPathComponent } from './runtime-composer-catalog'
export interface PluginTrialGuide {
  pluginName: string
  templates: PluginPathComponent[]
  app?: LocalDeviceApp
}
export function createPluginTrialGuide(
  pluginName: string,
  templates: PluginPathComponent[] = [],
  app?: LocalDeviceApp
): PluginTrialGuide | null {
  const name = pluginName.trim()
  const available = templates.filter(template => !template.unavailableReason).slice(0, 6)
  return name && available.length ? { pluginName: name, templates: available, app } : null
}

export function buildTrialTemplatePrompt(
  currentInput: string,
  template: PluginPathComponent,
  pluginName?: string
): string {
  const prefix = pluginName
    ? ([...currentInput.matchAll(/\[\$([^\]]+)\]\([^)]+\)/g)].find(
        match => match[1] === pluginName
      )?.[0] ?? '')
    : (currentInput.match(/^(\[\$[^\]]+\]\([^)]+\))\s*/)?.[1] ?? '')
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

export function buildRefinedPluginPrompt(currentInput: string, refinedPrompt: string): string {
  const mentionMatch = currentInput.match(/^(\[\$[^\]]+\]\([^)]+\))\s*/)
  const prefix = mentionMatch?.[1] ?? ''
  const prompt = refinedPrompt.trim()
  if (!prompt) return currentInput
  return prefix ? `${prefix} ${prompt} ` : `${prompt} `
}
