// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedSkill } from '@/apis/skills'
import type { TaskType } from '@/types/api'
import {
  buildSimpleBotRequest,
  buildSimpleTeamRequest,
  getSimpleBotName,
  type SimpleBotFormValue,
  type SimpleTeamFormValue,
} from '@/features/settings/components/team-edit/simple-team-edit-save'

const skills = [
  {
    id: 5,
    name: 'repo-reader',
    namespace: 'default',
    description: 'Read repository context',
    displayName: 'Repo Reader',
    is_active: true,
    is_public: false,
    user_id: 1,
  },
] as UnifiedSkill[]

const botForm: SimpleBotFormValue = {
  name: 'Helper Bot',
  shellName: 'Chat',
  modelName: 'gpt-4.1',
  modelType: 'public',
  modelNamespace: 'default',
  prompt: 'Answer clearly.',
  selectedSkills: ['repo-reader'],
  selectedSkillRefs: {},
  availableSkills: skills,
  defaultContextRefs: [{ type: 'knowledge_base', id: 10, name: 'Product Docs' }],
  defaultKnowledgeBaseRefs: [{ id: 10, name: 'Product Docs' }],
}

const teamForm: SimpleTeamFormValue = {
  name: 'support-agent',
  displayName: 'Support Agent',
  description: 'Answers customer questions',
  bindMode: ['chat'] as TaskType[],
  quickPhrases: ['  Create a support FAQ  ', '', 'Draft a customer reply'],
  icon: 'sparkles',
  requiresWorkspace: false,
  namespace: 'default',
}

describe('simple team edit save helpers', () => {
  it('derives a bot name from team name when bot name is empty', () => {
    expect(getSimpleBotName('', 'support-agent')).toBe('support-agent-bot')
    expect(getSimpleBotName('', '   ')).toBe('agent-bot')
    expect(getSimpleBotName('Helper', 'support-agent')).toBe('Helper')
  })

  it('builds a bot request with model, skills, knowledge bases, and prompt', () => {
    expect(buildSimpleBotRequest(botForm, 'support-agent')).toEqual({
      name: 'Helper Bot',
      shell_name: 'Chat',
      agent_config: {
        bind_model: 'gpt-4.1',
        bind_model_type: 'public',
      },
      system_prompt: 'Answer clearly.',
      mcp_servers: {},
      default_context_refs: [{ type: 'knowledge_base', id: 10, name: 'Product Docs' }],
      default_knowledge_base_refs: [{ id: 10, name: 'Product Docs' }],
      skills: ['repo-reader'],
      skill_refs: {
        'repo-reader': {
          skill_id: 5,
          namespace: 'default',
          is_public: false,
        },
      },
      preload_skills: [],
      preload_skill_refs: {},
    })
  })

  it('builds preload skill refs for selected preloaded skills', () => {
    const request = buildSimpleBotRequest(
      {
        ...botForm,
        preloadSkills: ['repo-reader', 'unknown-skill'],
      },
      'support-agent'
    )

    expect(request.preload_skills).toEqual(['repo-reader'])
    expect(request.preload_skill_refs).toEqual({
      'repo-reader': {
        skill_id: 5,
        namespace: 'default',
        is_public: false,
      },
    })
  })

  it('keeps MCP server config in the simple bot request', () => {
    const request = buildSimpleBotRequest(
      {
        ...botForm,
        mcpServers: {
          docs: {
            type: 'sse',
            url: 'https://example.com/mcp',
          },
        },
      },
      'support-agent'
    )

    expect(request.mcp_servers).toEqual({
      docs: {
        type: 'sse',
        url: 'https://example.com/mcp',
      },
    })
  })

  it('builds a solo team request with a leader bot', () => {
    expect(buildSimpleTeamRequest(teamForm, 42)).toEqual({
      name: 'support-agent',
      displayName: 'Support Agent',
      description: 'Answers customer questions',
      workflow: {
        mode: 'solo',
        leader_bot_id: 42,
      },
      bind_mode: ['chat'],
      bots: [
        {
          bot_id: 42,
          bot_prompt: '',
          role: 'leader',
        },
      ],
      quick_phrases: ['Create a support FAQ', 'Draft a customer reply'],
      namespace: 'default',
      icon: 'sparkles',
      requires_workspace: false,
    })
  })

  it('omits empty optional team fields', () => {
    const request = buildSimpleTeamRequest(
      {
        ...teamForm,
        displayName: '',
        description: '',
        icon: null,
        namespace: undefined,
        requiresWorkspace: null,
      },
      42
    )

    expect(request).toMatchObject({
      name: 'support-agent',
      displayName: undefined,
      description: undefined,
      namespace: undefined,
      icon: undefined,
      requires_workspace: undefined,
    })
  })
})
