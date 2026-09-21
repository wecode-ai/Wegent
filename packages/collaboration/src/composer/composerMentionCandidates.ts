import type { LocalDeviceApp, LocalDeviceSkill } from '@wegent/chat-core/runtime-composer-catalog'
import type { CollaborationTranslate } from '../i18n'
import { displaySkillNameFromName, localSkillTestId } from './composerMentions'
export type ComposerMentionCandidate<Project = unknown, Conversation = unknown> =
  | {
      kind: 'extension'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
    }
  | {
      kind: 'skill'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      skill: LocalDeviceSkill
    }
  | {
      kind: 'app'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      app: LocalDeviceApp
    }
  | {
      kind: 'cloud'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      statusLabel?: string
      project?: Project
    }
  | {
      kind: 'conversation'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      conversation: Conversation
    }

export type ComposerSkillMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'skill' }>
export type ComposerAppMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'app' }>
export type ComposerCloudMentionCandidate<Project = unknown> = Extract<
  ComposerMentionCandidate<Project>,
  { kind: 'cloud' }
>
export type ComposerConversationMentionCandidate<Conversation = unknown> = Extract<
  ComposerMentionCandidate<unknown, Conversation>,
  { kind: 'conversation' }
>

export function matchesMentionQuery(candidate: ComposerMentionCandidate, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  const description = candidate.description || ''
  return (
    candidate.title.toLowerCase().includes(normalizedQuery) ||
    description.toLowerCase().includes(normalizedQuery) ||
    candidate.searchAliases.some(alias => alias.toLowerCase().includes(normalizedQuery))
  )
}

export function displaySkillName(skill: LocalDeviceSkill): string {
  return displaySkillNameFromName(skill.name)
}

export function displayAppName(app: LocalDeviceApp): string {
  return app.name || app.id
}

export function displaySkillSource(skill: LocalDeviceSkill, t: CollaborationTranslate): string {
  if (skill.source_label) return skill.source_label

  switch (skill.scope) {
    case 'user':
    case 'repo':
      return t('workbench.skill_scope_personal', 'Personal')
    case 'system':
    case 'admin':
      return t('workbench.skill_scope_system', 'System')
    default:
      break
  }

  if (skill.source === 'codex' || skill.source === 'codex-plugin') {
    return t('workbench.skill_scope_personal', 'Personal')
  }
  return skill.source
}

export function slashSkillTestId(name: string): string {
  return `skill-${localSkillTestId(name)}`
}

export function slashAppTestId(id: string): string {
  return `app-${localSkillTestId(id)}`
}

export function dedupeLocalSkills(input: LocalDeviceSkill[]): LocalDeviceSkill[] {
  const deduped = new Map<string, LocalDeviceSkill>()
  input.forEach(skill => {
    const key = (skill.name || skill.path).trim().toLowerCase()
    const current = deduped.get(key)
    deduped.set(key, current ? preferLocalSkill(current, skill) : skill)
  })
  return Array.from(deduped.values())
}

function preferLocalSkill(left: LocalDeviceSkill, right: LocalDeviceSkill): LocalDeviceSkill {
  const leftRank = skillSourceRank(left)
  const rightRank = skillSourceRank(right)
  if (leftRank !== rightRank) return leftRank < rightRank ? left : right
  return (left.mtime ?? 0) >= (right.mtime ?? 0) ? left : right
}

function skillSourceRank(skill: LocalDeviceSkill): number {
  if (skill.source_priority !== undefined) return skill.source_priority
  if (skill.source === 'codex') return 0
  if (skill.source === 'codex-plugin') return 1
  return 2
}

export function skillReference(skill: LocalDeviceSkill): string {
  return `[$${skill.name}](${skill.path})`
}

export function appReference(app: LocalDeviceApp): string {
  if (app.skillPath) return `[$${app.name || app.id}](${app.skillPath})`
  return `[$${app.name || app.id}](app://${app.id})`
}
