// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CreateBotRequest, KnowledgeBaseDefaultRef, SkillRefMeta } from '@/apis/bots'
import type { ModelTypeEnum } from '@/apis/models'
import type { UnifiedSkill } from '@/apis/skills'
import type { CreateTeamRequest } from '@/apis/team'
import type { TaskType } from '@/types/api'
import { createPredefinedModelConfig } from '@/features/settings/services/bots'
import { buildSkillRefsFromSelection } from '@/features/settings/utils/skillRefResolver'

export interface SimpleBotFormValue {
  name: string
  shellName: string
  modelName: string
  modelType?: ModelTypeEnum
  modelNamespace?: string
  prompt: string
  selectedSkills: string[]
  selectedSkillRefs: Record<string, SkillRefMeta>
  preloadSkills?: string[]
  availableSkills: UnifiedSkill[]
  defaultKnowledgeBaseRefs: KnowledgeBaseDefaultRef[]
  mcpServers?: Record<string, unknown>
}

export interface SimpleTeamFormValue {
  name: string
  displayName: string
  description: string
  bindMode: TaskType[]
  icon?: string | null
  requiresWorkspace?: boolean | null
  namespace?: string
}

type ResourceScope = 'personal' | 'group' | 'all' | 'public'

export function getSimpleBotName(botName: string, teamName: string): string {
  const trimmedBotName = botName.trim()
  if (trimmedBotName) {
    return trimmedBotName
  }

  const trimmedTeamName = teamName.trim()
  return trimmedTeamName ? `${trimmedTeamName}-bot` : 'agent-bot'
}

export function buildSimpleBotRequest(
  form: SimpleBotFormValue,
  teamName: string,
  scope?: ResourceScope,
  groupName?: string
): CreateBotRequest {
  const agentConfig =
    createPredefinedModelConfig(form.modelName, form.modelType, form.modelNamespace, undefined) ??
    {}
  const preloadSkills = (form.preloadSkills || []).filter(skillName =>
    form.selectedSkills.includes(skillName)
  )

  return {
    name: getSimpleBotName(form.name, teamName),
    shell_name: form.shellName,
    agent_config: agentConfig,
    system_prompt: form.prompt.trim(),
    mcp_servers: form.mcpServers || {},
    default_knowledge_base_refs: form.defaultKnowledgeBaseRefs,
    skills: form.selectedSkills,
    skill_refs: buildSkillRefsFromSelection(
      form.selectedSkills,
      form.selectedSkillRefs,
      form.availableSkills,
      scope,
      groupName
    ),
    preload_skills: preloadSkills,
    preload_skill_refs: buildSkillRefsFromSelection(
      preloadSkills,
      form.selectedSkillRefs,
      form.availableSkills,
      scope,
      groupName
    ),
  }
}

export function buildSimpleTeamRequest(
  form: SimpleTeamFormValue,
  botId: number
): CreateTeamRequest {
  const trimmedDisplayName = form.displayName.trim()
  const trimmedDescription = form.description.trim()

  return {
    name: form.name.trim(),
    displayName: trimmedDisplayName || undefined,
    description: trimmedDescription || undefined,
    workflow: {
      mode: 'solo',
      leader_bot_id: botId,
    },
    bind_mode: form.bindMode,
    bots: [
      {
        bot_id: botId,
        bot_prompt: '',
        role: 'leader',
      },
    ],
    namespace: form.namespace,
    icon: form.icon || undefined,
    requires_workspace: form.requiresWorkspace ?? undefined,
  }
}
