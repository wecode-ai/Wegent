import {
  ClipboardList,
  CornerDownLeft,
  Cpu,
  ExternalLink,
  Package,
  Plug,
  Store,
  Target,
} from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import type { SlashCommand } from './composerAutocomplete'
import { localSkillTestId } from './composerMentions'

interface CatalogCandidate {
  key: string
  title: string
  description?: string
  metaLabel: string
  searchAliases: string[]
  enabled: boolean
}
export function createComposerActionCommands({
  translate: t,
  planModeActive,
  onSetPlanMode,
  onSetGoal,
  onOpenModels,
}: {
  translate: CollaborationTranslate
  planModeActive: boolean
  onSetPlanMode?: () => void
  onSetGoal?: () => void
  onOpenModels?: () => void
}): SlashCommand<never, never>[] {
  const commands: SlashCommand<never, never>[] = []
  if (onSetPlanMode && !planModeActive)
    commands.push({
      id: 'plan',
      title: t('workbench.slash_command_plan'),
      description: t('workbench.slash_command_plan_description'),
      searchAliases: ['plan', 'plan mode', 'planning'],
      Icon: ClipboardList,
      testId: 'plan',
      onSelect: onSetPlanMode,
    })
  if (onSetGoal)
    commands.push({
      id: 'goal',
      title: t('workbench.slash_command_goal'),
      description: t('workbench.slash_command_goal_description'),
      searchAliases: ['goal', 'target', 'objective'],
      Icon: Target,
      testId: 'goal',
      onSelect: onSetGoal,
    })
  if (onOpenModels)
    commands.push({
      id: 'model',
      title: t('workbench.slash_command_model'),
      description: t('workbench.slash_command_model_description'),
      searchAliases: ['model', 'model selector'],
      Icon: Cpu,
      testId: 'model',
      onSelect: onOpenModels,
    })
  return commands
}
export function createSkillSlashCommands<Skill extends { name: string }>(
  candidates: Array<CatalogCandidate & { skill: Skill }>,
  translate: CollaborationTranslate
): SlashCommand<never, Skill>[] {
  const group = translate('workbench.slash_command_group_skills')
  return candidates.map(candidate => ({
    id: candidate.key,
    title: candidate.title,
    description: candidate.description,
    metaLabel: candidate.metaLabel,
    group,
    searchAliases: candidate.searchAliases,
    Icon: Package,
    enabled: candidate.enabled,
    testId: `skill-${localSkillTestId(candidate.skill.name)}`,
    skill: candidate.skill,
  }))
}
export function createPluginSlashCommands<App extends { id: string }>(
  candidates: Array<CatalogCandidate & { app: App }>,
  {
    translate: t,
    resolveLogo,
    onOpenMarketplace,
  }: {
    translate: CollaborationTranslate
    resolveLogo(app: App): { url: string | null; contrastPad: boolean }
    onOpenMarketplace?: () => void
  }
): SlashCommand<App, never>[] {
  const group = t('workbench.slash_command_group_plugins', '插件')
  const commands: SlashCommand<App, never>[] = candidates.map(candidate => {
    const logo = resolveLogo(candidate.app)
    return {
      id: candidate.key,
      title: candidate.title,
      description: candidate.description,
      group,
      searchAliases: candidate.searchAliases,
      Icon: Plug,
      iconUrl: logo.url,
      iconContrastPad: logo.contrastPad,
      trailingIcon: CornerDownLeft,
      enabled: candidate.enabled,
      testId: `app-${localSkillTestId(candidate.app.id)}`,
      app: candidate.app,
    }
  })
  if (onOpenMarketplace)
    commands.push({
      id: 'plugin-marketplace',
      title: t('workbench.composer_open_plugin_marketplace', '打开插件市场'),
      description: t('workbench.composer_open_plugin_marketplace_hint', '浏览和搜索全部插件'),
      group,
      searchAliases: ['plugin', 'plugins', 'marketplace', '插件', '插件市场'],
      Icon: Store,
      trailingIcon: ExternalLink,
      testId: 'plugin-marketplace',
      onSelect: onOpenMarketplace,
    })
  return commands
}
