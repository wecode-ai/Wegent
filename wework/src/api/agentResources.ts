import type { HttpClient } from './http'
import type { ModelType, UnifiedModel, UnifiedModelListResponse, UnifiedSkill } from '@/types/api'

export type UnifiedAgentRuntime = 'Codex' | 'ClaudeCode'

export interface UnifiedAgentSkillRef {
  skillId: number
  name: string
  namespace: string
  isPublic: boolean
}

export interface UnifiedAgentSpec {
  name: string
  displayName: string
  namespace: string
  runtime: UnifiedAgentRuntime
  model: {
    name: string
    type?: ModelType
    namespace?: string
  }
  systemPrompt: string
  skills: UnifiedAgentSkillRef[]
  mcpServers: Record<string, unknown>
}

interface CreatedBot {
  id: number
}

export interface CreatedAgentResource {
  id: number
  name: string
  displayName?: string | null
  namespace?: string | null
}

function agentConfig(spec: UnifiedAgentSpec): Record<string, unknown> {
  return {
    bind_model: spec.model.name,
    ...(spec.model.type ? { bind_model_type: spec.model.type } : {}),
    ...(spec.model.namespace && spec.model.namespace !== 'default'
      ? { bind_model_namespace: spec.model.namespace }
      : {}),
  }
}

export function createAgentResourceApi(client: HttpClient) {
  return {
    listModels(): Promise<UnifiedModel[]> {
      const query = new URLSearchParams()
      query.set('include_config', 'true')
      query.set('scope', 'all')
      query.set('model_category_type', 'llm')
      query.set('client_origin', 'wework')
      return client
        .get<UnifiedModelListResponse>(`/models/unified?${query.toString()}`)
        .then(response => response.data)
    },
    listSkills(): Promise<UnifiedSkill[]> {
      const query = new URLSearchParams()
      query.set('scope', 'all')
      return client.get(`/v1/kinds/skills/unified?${query.toString()}`)
    },
    async createAgent(spec: UnifiedAgentSpec): Promise<CreatedAgentResource> {
      const skillRefs = Object.fromEntries(
        spec.skills.map(skill => [
          skill.name,
          {
            skill_id: skill.skillId,
            namespace: skill.namespace,
            is_public: skill.isPublic,
          },
        ])
      )
      const bot = await client.post<CreatedBot>('/bots', {
        name: `${spec.name}-bot`,
        shell_name: spec.runtime,
        agent_config: agentConfig(spec),
        system_prompt: spec.systemPrompt.trim(),
        mcp_servers: spec.mcpServers,
        skills: spec.skills.map(skill => skill.name),
        skill_refs: skillRefs,
        preload_skills: [],
        preload_skill_refs: {},
        target_group_names: spec.namespace === 'default' ? [] : [spec.namespace],
        namespace: spec.namespace,
      })

      return client.post<CreatedAgentResource>('/teams', {
        name: spec.name,
        displayName: spec.displayName.trim() || undefined,
        description: '',
        workflow: {
          mode: 'solo',
          leader_bot_id: bot.id,
        },
        bind_mode: ['code', 'task'],
        bots: [
          {
            bot_id: bot.id,
            bot_prompt: '',
            role: 'leader',
          },
        ],
        namespace: spec.namespace,
        requires_workspace: true,
      })
    },
  }
}
