import { useTranslation } from '@/hooks/useTranslation'
import { getModelCompatibilityFamily, inferModelFamily } from '@/lib/model-ui'
import type { LocalDeviceApp, LocalDeviceSkill, UnifiedModel } from '@/types/api'
import { displaySkillNameFromName, localSkillTestId } from './composerMentions'

type CommonTranslate = ReturnType<typeof useTranslation>['t']

export type ComposerMentionCandidate =
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

export type ComposerSkillMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'skill' }>
export type ComposerAppMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'app' }>

export function displaySkillName(skill: LocalDeviceSkill): string {
  return displaySkillNameFromName(skill.name)
}

export function displayAppName(app: LocalDeviceApp): string {
  return app.name || app.id
}

export function displaySkillSource(skill: LocalDeviceSkill, t: CommonTranslate): string {
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

export function canSelectSkillForModel(
  skill: LocalDeviceSkill,
  selectedModel?: UnifiedModel | null
): boolean {
  if (!selectedModel) return true

  const runtime = inferSkillRuntime(selectedModel)
  if (runtime === 'claude') return isClaudeSkill(skill)
  if (runtime === 'codex') return isCodexSkill(skill)
  return skill.source === 'agents' || !isCodexSkill(skill)
}

function inferSkillRuntime(model: UnifiedModel): 'claude' | 'codex' | null {
  const provider = getModelConfigProvider(model)
  const runtimeFamily = getModelCompatibilityFamily(model)
  const runtimeProtocol = runtimeFamily?.split('.').filter(Boolean).at(-1) ?? ''
  const protocol = normalizeRuntimeSignal(model.config?.protocol)
  const apiFormat = normalizeRuntimeSignal(model.config?.apiFormat ?? model.config?.api_format)

  if (provider === 'claude' || runtimeProtocol === 'claude' || protocol === 'claude') {
    return 'claude'
  }
  if (
    provider === 'openai' ||
    runtimeProtocol === 'openai-responses' ||
    protocol === 'openai-responses' ||
    apiFormat === 'responses'
  ) {
    return 'codex'
  }

  const family = inferModelFamily(model)
  if (family === 'claude') return 'claude'
  if (family === 'gpt') return 'codex'
  return null
}

function getModelConfigProvider(model: UnifiedModel): string {
  const config = objectRecord(model.config)
  const directEnv = objectRecord(config?.env)
  const nestedModelConfig = objectRecord(config?.modelConfig)
  const nestedEnv = objectRecord(nestedModelConfig?.env)
  return (
    normalizeRuntimeSignal(model.runtime?.provider) ||
    normalizeRuntimeSignal(directEnv?.model) ||
    normalizeRuntimeSignal(nestedEnv?.model) ||
    normalizeRuntimeSignal(model.provider)
  )
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeRuntimeSignal(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isClaudeSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'claude' || skill.source === 'claude-plugin'
}

function isCodexSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'codex' || skill.source === 'codex-plugin'
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
  return `[$${app.name || app.id}](app://${app.id})`
}
