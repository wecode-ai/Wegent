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

/** The editable Agent resource behind a Team plus its leader Bot. */
export interface AgentResourceDetail {
  teamId: number
  botId: number
  name: string
  displayName: string
  namespace: string
  /** Null when the Bot uses a Shell this form cannot represent. */
  runtime: UnifiedAgentRuntime | null
  shellName: string
  model: {
    name: string
    type?: ModelType
    namespace?: string
  }
  systemPrompt: string
  skills: UnifiedAgentSkillRef[]
  mcpServers: Record<string, unknown>
}

interface BotSkillRef {
  skill_id: number
  namespace?: string | null
  is_public?: boolean | null
}

interface TeamDetailBot {
  id: number
  name: string
  namespace?: string | null
  shell_name?: string | null
  agent_config?: Record<string, unknown> | null
  system_prompt?: string | null
  mcp_servers?: Record<string, unknown> | null
  skills?: string[] | null
  skill_refs?: Record<string, BotSkillRef> | null
}

interface TeamDetailResponse {
  id: number
  name: string
  displayName?: string | null
  namespace?: string | null
  bots?: { bot: TeamDetailBot; role?: string | null }[] | null
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

function botSkillRefs(spec: UnifiedAgentSpec): Record<string, unknown> {
  return Object.fromEntries(
    spec.skills.map(skill => [
      skill.name,
      {
        skill_id: skill.skillId,
        namespace: skill.namespace,
        is_public: skill.isPublic,
      },
    ])
  )
}

function botCapabilityPayload(spec: UnifiedAgentSpec): Record<string, unknown> {
  return {
    shell_name: spec.runtime,
    agent_config: agentConfig(spec),
    system_prompt: spec.systemPrompt.trim(),
    mcp_servers: spec.mcpServers,
    skills: spec.skills.map(skill => skill.name),
    skill_refs: botSkillRefs(spec),
  }
}

function leaderBot(team: TeamDetailResponse): TeamDetailBot {
  const entries = team.bots ?? []
  const leader = entries.find(entry => entry.role === 'leader') ?? entries[0]
  if (!leader?.bot) {
    throw new Error(`Agent ${team.name} has no bot to edit`)
  }
  return leader.bot
}

function detailRuntime(shellName: string): UnifiedAgentRuntime | null {
  if (shellName === 'ClaudeCode') return 'ClaudeCode'
  return shellName === 'Codex' ? 'Codex' : null
}

const MODEL_TYPES: ModelType[] = ['public', 'user', 'group', 'runtime']

function detailModelType(value: unknown): ModelType | undefined {
  return MODEL_TYPES.find(candidate => candidate === value)
}

function detailSkills(bot: TeamDetailBot): UnifiedAgentSkillRef[] {
  const refs = bot.skill_refs ?? {}
  return (bot.skills ?? []).map(name => {
    const ref = refs[name]
    return {
      skillId: ref?.skill_id ?? 0,
      name,
      namespace: ref?.namespace || 'default',
      isPublic: Boolean(ref?.is_public),
    }
  })
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
      const bot = await client.post<CreatedBot>('/bots', {
        name: `${spec.name}-bot`,
        ...botCapabilityPayload(spec),
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
    async getAgent(teamId: number): Promise<AgentResourceDetail> {
      const team = await client.get<TeamDetailResponse>(`/teams/${teamId}`)
      const bot = leaderBot(team)
      const config = bot.agent_config ?? {}
      const shellName = bot.shell_name ?? ''
      return {
        teamId: team.id,
        botId: bot.id,
        name: team.name,
        displayName: team.displayName ?? '',
        namespace: team.namespace || bot.namespace || 'default',
        runtime: detailRuntime(shellName),
        shellName,
        model: {
          name: typeof config.bind_model === 'string' ? config.bind_model : '',
          type: detailModelType(config.bind_model_type),
          namespace:
            typeof config.bind_model_namespace === 'string'
              ? config.bind_model_namespace
              : 'default',
        },
        systemPrompt: bot.system_prompt ?? '',
        skills: detailSkills(bot),
        mcpServers: bot.mcp_servers ?? {},
      }
    },
    /**
     * Updates the Agent resource in place. The technical name and namespace are
     * identity fields and stay untouched so existing bindings keep resolving.
     */
    async updateAgent(
      target: { teamId: number; botId: number },
      spec: UnifiedAgentSpec
    ): Promise<CreatedAgentResource> {
      await client.put(`/bots/${target.botId}`, botCapabilityPayload(spec))
      return client.put<CreatedAgentResource>(`/teams/${target.teamId}`, {
        displayName: spec.displayName.trim(),
      })
    },
  }
}
