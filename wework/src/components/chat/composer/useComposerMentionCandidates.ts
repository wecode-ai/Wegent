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
  matchesMentionQuery,
  skillReference,
  type ComposerAppMentionCandidate,
  type ComposerCloudMentionCandidate,
  type ComposerConversationMentionCandidate,
  type ComposerSkillMentionCandidate,
} from './composerMentionCandidates'
import { localSkillTestId } from './composerMentions'

export function useComposerMentionCandidates(
  apps: LocalDeviceApp[],
  skills: LocalDeviceSkill[],
  selectedModel: UnifiedModel | null | undefined,
  query: string,
  cloudCandidates: ComposerCloudMentionCandidate[] = [],
  conversationCandidates: ComposerConversationMentionCandidate[] = []
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
  const visibleConversationCandidates = useMemo(() => {
    const filtered = conversationCandidates.filter(candidate =>
      matchesMentionQuery(candidate, query)
    )
    return query.trim() ? filtered : filtered.slice(0, 5)
  }, [conversationCandidates, query])
  const mentionCandidates = useMemo(
    () => [
      ...visibleConversationCandidates,
      ...cloudCandidates,
      ...skillCandidates,
      ...appCandidates,
    ],
    [appCandidates, cloudCandidates, skillCandidates, visibleConversationCandidates]
  )
  const filteredMentionCandidates = useMemo(
    () => mentionCandidates.filter(candidate => matchesMentionQuery(candidate, query)),
    [mentionCandidates, query]
  )

  return { appCandidates, skillCandidates, mentionCandidates, filteredMentionCandidates }
}
