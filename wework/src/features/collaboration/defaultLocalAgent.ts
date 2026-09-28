import type {
  LocalProjectChatAgent,
  LocalProjectChatAgentCreateInput,
  createLocalProjectChatAgentApi,
} from '@/api/local/localDelivery'

export const DEFAULT_LOCAL_AGENT_NAMES = [
  'current-device-agent',
  'current-device-assistant',
] as const

const pendingDefaultAgents = new WeakMap<
  ReturnType<typeof createLocalProjectChatAgentApi>,
  Map<string, Promise<LocalProjectChatAgent>>
>()

export function isDefaultLocalAgentName(name: string | undefined): boolean {
  return DEFAULT_LOCAL_AGENT_NAMES.includes(name as (typeof DEFAULT_LOCAL_AGENT_NAMES)[number])
}

export function isDefaultLocalAgent(agent: Pick<LocalProjectChatAgent, 'name'>): boolean {
  return isDefaultLocalAgentName(agent.name)
}

function defaultLocalAgentInput(locale: 'zh-CN' | 'en'): LocalProjectChatAgentCreateInput {
  return {
    name: 'current-device-agent',
    displayName: locale === 'zh-CN' ? '当前设备智能体' : 'Current device Agent',
    namespace: 'default',
    runtime: 'codex',
    model: null,
    modelType: null,
    modelNamespace: 'default',
    capabilityDescription:
      locale === 'zh-CN'
        ? '使用当前设备的模型、技能和工具。'
        : 'Uses models, skills, and tools available on the current device.',
    capabilityMode: 'follow_device',
    systemPrompt: '',
    executionEnvironment: 'local',
    executionMode: 'auto',
    executionDeviceId: null,
    workspacePolicy: 'project',
  }
}

export async function ensureDefaultLocalAgent(
  api: ReturnType<typeof createLocalProjectChatAgentApi>,
  projectId: string,
  locale: 'zh-CN' | 'en',
  listedAgents?: LocalProjectChatAgent[]
): Promise<LocalProjectChatAgent> {
  const agents = listedAgents ?? (await api.list(projectId))
  const existing = agents.find(agent => agent.status === 'active' && isDefaultLocalAgent(agent))
  if (existing) return existing

  let pendingByProject = pendingDefaultAgents.get(api)
  if (!pendingByProject) {
    pendingByProject = new Map()
    pendingDefaultAgents.set(api, pendingByProject)
  }
  const pending = pendingByProject.get(projectId)
  if (pending) return pending

  const input = defaultLocalAgentInput(locale)
  const promise = (async () => {
    const created = await api.ensureDefault(projectId, input)
    if (created) return created

    const concurrent = (await api.list(projectId)).find(
      agent => agent.status === 'active' && isDefaultLocalAgent(agent)
    )
    if (concurrent) return concurrent
    return api.create(projectId, input)
  })()
  pendingByProject.set(projectId, promise)
  try {
    return await promise
  } finally {
    pendingByProject.delete(projectId)
    if (pendingByProject.size === 0) pendingDefaultAgents.delete(api)
  }
}
