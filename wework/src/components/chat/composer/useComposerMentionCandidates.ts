import { useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalDeviceApp, LocalDeviceSkill, UnifiedModel } from '@/types/api'
import {
  appReference,
  canSelectSkillForModel,
  dedupeLocalSkills,
  displayAppName,
  displaySkillName,
  displaySkillSource,
  skillReference,
  type ComposerAppMentionCandidate,
  type ComposerCloudMentionCandidate,
  type ComposerSkillMentionCandidate,
} from './composerMentionCandidates'
import { localSkillTestId } from './composerMentions'

export function useComposerMentionCandidates(
  apps: LocalDeviceApp[],
  skills: LocalDeviceSkill[],
  selectedModel: UnifiedModel | null | undefined,
  query: string,
  cloudCandidates: ComposerCloudMentionCandidate[] = []
) {
  const { t } = useTranslation('common')
  const appCandidates = useMemo<ComposerAppMentionCandidate[]>(
    () =>
      apps.map(app => {
        const pluginNames = app.pluginDisplayNames ?? []
        return {
          kind: 'app',
          key: `app:${app.id}`,
          title: displayAppName(app),
          description: app.description ?? undefined,
          metaLabel: pluginNames[0] ?? t('workbench.skill_scope_personal', 'Personal'),
          testId: localSkillTestId(app.id),
          enabled: app.isEnabled !== false && app.isAccessible !== false,
          reference: appReference(app),
          searchAliases: [app.id, app.name, app.description ?? '', ...pluginNames],
          app,
        }
      }),
    [apps, t]
  )
  const skillCandidates = useMemo<ComposerSkillMentionCandidate[]>(
    () =>
      dedupeLocalSkills(skills).map(skill => {
        const description = skill.short_description || skill.description || undefined
        return {
          kind: 'skill',
          key: `skill:${skill.path}`,
          title: displaySkillName(skill),
          description,
          metaLabel: displaySkillSource(skill, t),
          testId: localSkillTestId(skill.name),
          enabled: canSelectSkillForModel(skill, selectedModel),
          reference: skillReference(skill),
          searchAliases: [skill.name, skill.plugin_name ?? '', description ?? ''],
          skill,
        }
      }),
    [selectedModel, skills, t]
  )
  const mentionCandidates = useMemo(
    () => [...cloudCandidates, ...skillCandidates, ...appCandidates],
    [appCandidates, cloudCandidates, skillCandidates]
  )
  const filteredMentionCandidates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return mentionCandidates
    return mentionCandidates.filter(candidate => {
      const description = candidate.description || ''
      return (
        candidate.title.toLowerCase().includes(normalizedQuery) ||
        description.toLowerCase().includes(normalizedQuery) ||
        candidate.searchAliases.some(alias => alias.toLowerCase().includes(normalizedQuery))
      )
    })
  }, [mentionCandidates, query])

  return { appCandidates, skillCandidates, mentionCandidates, filteredMentionCandidates }
}
