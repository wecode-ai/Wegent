import { useMemo } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { LocalDeviceApp, LocalDeviceSkill } from '@wegent/chat-core/runtime-composer-catalog'
import {
  appReference,
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

export function useComposerMentionCandidates<Project = unknown, Conversation = unknown>(
  apps: LocalDeviceApp[],
  skills: LocalDeviceSkill[],
  query: string,
  cloudCandidates: ComposerCloudMentionCandidate<Project>[] = [],
  conversationCandidates: ComposerConversationMentionCandidate<Conversation>[] = [],
  t: CollaborationTranslate,
  compareApps?: (left: LocalDeviceApp, right: LocalDeviceApp) => number
) {
  const appCandidates = useMemo<ComposerAppMentionCandidate[]>(() => {
    const orderedApps = [...apps].sort(
      compareApps ?? ((left, right) => displayAppName(left).localeCompare(displayAppName(right)))
    )
    return orderedApps.map(app => {
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
    })
  }, [apps, t, compareApps])
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
          enabled: true,
          reference: skillReference(skill),
          searchAliases: [skill.name, skill.plugin_name ?? '', description ?? ''],
          skill,
        }
      }),
    [skills, t]
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
