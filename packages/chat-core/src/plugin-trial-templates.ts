import type { InstalledPlugin } from './installed-plugin-types'
import type { PluginPathComponent } from './runtime-composer-catalog'
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
  const components = plugin.spec.components
  const templatesOrCommands = Array.isArray(components?.templates)
    ? components.templates
    : Array.isArray(components?.commands)
      ? components.commands
      : []
  const nativeTemplates = templatesOrCommands.filter(template => !template.unavailableReason)
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
