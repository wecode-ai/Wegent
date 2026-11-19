import { BookOpenText, Boxes, Sparkles, TerminalSquare } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import type { ResolvedAppearanceMode } from '@/features/appearance/types'
import { resolvePreferredPluginLogo } from './plugin-assets'
import { formatPluginVersion } from './plugin-display'

export interface DetailComponentItem {
  key: string
  componentKey: string
  type: string
  name: string
  description: string
  toggleable: boolean
}

export function formatManifestValue(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') {
      const email = typeof record.email === 'string' && record.email ? ` <${record.email}>` : ''
      return `${record.name}${email}`
    }
    if (typeof record.url === 'string') return record.url
  }
  return ''
}

export function buildComponentItems(plugin: InstalledPlugin): DetailComponentItem[] {
  const components = plugin.spec.components
  return [
    ...components.skills.map(item => ({
      key: `skill-${item.name}`,
      componentKey: `skill:${item.name}`,
      type: 'skill',
      name: item.name,
      description: item.description || item.path,
      toggleable: true,
    })),
    ...components.commands.map(item => ({
      key: `command-${item.name}`,
      componentKey: `command:${item.name}`,
      type: 'command',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...(components.apps ?? []).map(item => ({
      key: `app-${item.name}`,
      componentKey: `app:${item.name}`,
      type: 'app',
      name: item.name,
      description: item.description || item.path,
      toggleable: false,
    })),
    ...components.agents.map(item => ({
      key: `agent-${item.name}`,
      componentKey: `agent:${item.name}`,
      type: 'agent',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.hooks.map(item => ({
      key: `hook-${item.name}`,
      componentKey: `hook:${item.name}`,
      type: 'hook',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.mcps.map(item => ({
      key: `mcp-${item.name}`,
      componentKey: `mcp:${item.name}`,
      type: 'mcp',
      name: item.name,
      description:
        typeof item.server.description === 'string'
          ? item.server.description
          : typeof item.server.command === 'string'
            ? item.server.command
            : item.name,
      toggleable: false,
    })),
    ...(components.connectors ?? []).map(item => ({
      key: `connector-${item.slug}`,
      componentKey: `connector:${item.slug}`,
      type: 'connector',
      name: item.slug,
      description:
        item.description ||
        (item.authPolicy === 'on_install' ? '安装和使用此插件需要授权' : '可选应用连接'),
      toggleable: false,
    })),
    ...components.lsps.map(item => ({
      key: `lsp-${item.name}`,
      componentKey: `lsp:${item.name}`,
      type: 'lsp',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.monitors.map(item => ({
      key: `monitor-${item.name}`,
      componentKey: `monitor:${item.name}`,
      type: 'monitor',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.bins.map(item => ({
      key: `bin-${item.name}`,
      componentKey: `bin:${item.name}`,
      type: 'bin',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
  ]
}

export function installedPluginLogo(
  plugin: InstalledPluginItem,
  appearanceMode: ResolvedAppearanceMode
) {
  return resolvePreferredPluginLogo({
    pluginKey: plugin.raw.spec.source.pluginKey || plugin.name,
    appearanceMode,
    interfaces: [plugin.raw.spec.interface],
  })
}

export function pluginDisplayDescription(plugin: InstalledPluginItem): string {
  return (
    plugin.raw.spec.interface?.longDescription ||
    plugin.raw.spec.interface?.shortDescription ||
    plugin.description
  )
}

interface PluginGuideExample {
  id: string
  prompt: string
}

function escapeGuidePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function pluginGuideDisplayPrompt(pluginName: string, prompt: string): string {
  const normalizedPrompt = prompt.trim()
  const normalizedName = pluginName.trim()
  if (!normalizedPrompt || !normalizedName) return normalizedPrompt

  const pluginPattern = escapeGuidePattern(normalizedName)
  const prefixes = [
    new RegExp(`^use\\s+${pluginPattern}\\s+to\\s+`, 'i'),
    new RegExp(`^use\\s+${pluginPattern}\\s+`, 'i'),
    new RegExp(`^使用\\s*${pluginPattern}\\s*`, 'i'),
    new RegExp(`^用\\s*${pluginPattern}\\s*`, 'i'),
  ]
  const stripped = prefixes.reduce(
    (value, pattern) => (value === normalizedPrompt ? value.replace(pattern, '') : value),
    normalizedPrompt
  )
  if (!stripped || stripped === normalizedPrompt) return normalizedPrompt

  const [first = '', ...rest] = Array.from(stripped)
  return `${first.toLocaleUpperCase()}${rest.join('')}`
}

export function pluginGuideExamples(plugin: InstalledPluginItem): PluginGuideExample[] {
  const templates = (plugin.raw.spec.components.templates ?? plugin.raw.spec.components.commands)
    .filter(template => !template.unavailableReason)
    .slice(0, 3)
  if (templates.length > 0) {
    return templates.map((template, index) => ({
      id: template.path || `template-${index}`,
      prompt: template.description?.trim() || template.name,
    }))
  }

  const prompts = normalizePromptExamples(plugin.raw.spec.interface?.defaultPrompt)
  const examples =
    prompts.length > 0
      ? prompts.slice(0, 3)
      : [
          `Use ${plugin.name} to summarize the current project status`,
          `Use ${plugin.name} to create an editable working artifact`,
          `Use ${plugin.name} to inspect the latest files and suggest next steps`,
        ]

  return examples.map((prompt, index) => ({
    id: `prompt-${index}`,
    prompt,
  }))
}

function normalizePromptExamples(value: unknown): string[] {
  if (!value) return []
  if (typeof value === 'string') {
    const prompt = value.trim()
    return prompt ? [prompt] : []
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          const prompt = record.prompt || record.text || record.title
          return typeof prompt === 'string' ? prompt.trim() : ''
        }
        return ''
      })
      .filter(Boolean)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const prompt = record.prompt || record.text || record.title
    return typeof prompt === 'string' && prompt.trim() ? [prompt.trim()] : []
  }
  return []
}

export function pluginCapabilitySummary(plugin: InstalledPluginItem): string {
  const capabilities = plugin.raw.spec.interface?.capabilities
  if (capabilities && capabilities.length > 0) {
    return capabilities.join(', ')
  }
  const counts = plugin.componentCounts
  const countSummary = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key]) => key)
    .join(', ')
  if (countSummary) return countSummary

  const componentTypes = [
    ...new Set(
      buildComponentItems(plugin.raw)
        .filter(item => item.type !== 'connector')
        .map(item => item.type)
    ),
  ]
  return componentTypes.join(', ') || 'Plugin'
}

export function componentTypeLabel(
  type: string,
  t: ReturnType<typeof useTranslation>['t']
): string {
  switch (type) {
    case 'skill':
      return t('workbench.plugin_component_type_skill', '技能')
    case 'app':
      return t('workbench.plugin_component_type_app', '应用')
    case 'mcp':
      return t('workbench.plugin_component_type_mcp', 'MCP')
    case 'connector':
      return t('workbench.plugin_component_type_connector', '应用连接')
    case 'hook':
      return t('workbench.plugin_component_type_hook', 'Hook')
    case 'command':
      return t('workbench.plugin_component_type_command', '命令')
    case 'agent':
      return t('workbench.plugin_component_type_agent', '智能体')
    default:
      return type
  }
}

export function componentIcon(type: string) {
  switch (type) {
    case 'skill':
      return BookOpenText
    case 'mcp':
    case 'connector':
      return Boxes
    case 'command':
    case 'bin':
      return TerminalSquare
    default:
      return Sparkles
  }
}

export function detailRows(
  plugin: InstalledPlugin,
  isExternalSource: boolean,
  t: (key: string, defaultValue: string) => string
): Array<{
  label: string
  value: string
  href?: string
}> {
  const manifest = plugin.spec.manifest ?? {}
  const homepage = plugin.spec.interface?.websiteUrl || formatManifestValue(manifest.homepage)
  const privacyPolicy =
    plugin.spec.interface?.privacyPolicyUrl || formatManifestValue(manifest.privacyPolicy)
  const termsOfService =
    plugin.spec.interface?.termsOfServiceUrl || formatManifestValue(manifest.termsOfService)
  const rows: Array<{
    label: string
    value: string
    href?: string
  }> = [
    {
      label: t('workbench.plugin_detail_label_developer', '开发者'),
      value:
        plugin.spec.interface?.developerName ||
        formatManifestValue(manifest.author) ||
        plugin.spec.author ||
        '',
    },
    {
      label: t('workbench.plugin_detail_label_version', '版本'),
      value: formatPluginVersion(plugin.spec.version || formatManifestValue(manifest.version)),
    },
  ]
  if (isExternalSource && homepage) {
    rows.push({
      label: t('workbench.plugin_detail_label_website', '网站'),
      value: homepage,
      href: homepage.startsWith('http') ? homepage : undefined,
    })
  }
  if (isExternalSource && privacyPolicy) {
    rows.push({
      label: t('workbench.plugin_detail_label_privacy', '隐私政策'),
      value: privacyPolicy,
      href: privacyPolicy.startsWith('http') ? privacyPolicy : undefined,
    })
  }
  if (isExternalSource && termsOfService) {
    rows.push({
      label: t('workbench.plugin_detail_label_terms', '服务条款'),
      value: termsOfService,
      href: termsOfService.startsWith('http') ? termsOfService : undefined,
    })
  }
  return rows.filter(row => row.value)
}
