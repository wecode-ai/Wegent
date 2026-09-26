import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateCollaborationGroupDraftInput,
  ProjectCreateCollaborationGroupGenerationEvent,
} from '@wegent/collaboration'

import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

type TextGenerationApi = NonNullable<WorkbenchServices['textGenerationApi']>

function currentDeviceAgentId(input: ProjectCreateCollaborationGroupDraftInput): string | null {
  return (
    input.agents.find(agent => {
      const binding = agent.project_binding_input
      const resourceName = binding && typeof binding.name === 'string' ? binding.name.trim() : ''
      return resourceName === 'current-device-agent' || resourceName === 'current-device-assistant'
    })?.id ?? null
  )
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    return record(JSON.parse(content.trim()))
  } catch {
    throw new Error('AI 返回了无效的协作小组结构化结果')
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI 返回的协作小组方案格式不正确')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`AI 返回的协作小组方案缺少${field}`)
  }
  return value.trim()
}

function participantKey(kind: unknown, id: string, allowed: Set<string>): 'human' | 'agent' {
  if ((kind !== 'human' && kind !== 'agent') || !allowed.has(`${kind}:${id}`)) {
    throw new Error('AI 返回了不在当前项目中的协作者事件')
  }
  return kind
}

function parseGenerationEvent(
  value: unknown,
  allowed: Set<string>
): ProjectCreateCollaborationGroupGenerationEvent {
  const event = record(value)
  const type = requiredString(event.type, '事件类型')
  if (type === 'group') {
    return { type, name: requiredString(event.name, '小组名称') }
  }
  if (type === 'participant_started') {
    const id = requiredString(event.id, '成员 ID')
    return {
      type,
      kind: participantKey(event.kind, id, allowed),
      id,
      leader: event.leader === true,
    }
  }
  if (type === 'participant_delta') {
    const id = requiredString(event.id, '成员 ID')
    return {
      type,
      kind: participantKey(event.kind, id, allowed),
      id,
      delta: requiredString(event.delta, '职责增量'),
    }
  }
  if (type === 'principle') {
    return { type, text: requiredString(event.text, '分配原则') }
  }
  if (type === 'stage') {
    return {
      type,
      id: requiredString(event.id, '流程 ID'),
      name: requiredString(event.name, '流程名称'),
    }
  }
  throw new Error(`AI 返回了未知的协作小组事件：${type}`)
}

function allowedParticipantKeys(input: ProjectCreateCollaborationGroupDraftInput): Set<string> {
  return new Set([
    `human:${input.currentUser.id}`,
    ...input.members.map(member => `human:${member.user_id}`),
    ...input.agents.map(agent => `agent:${agent.id}`),
  ])
}

function createGenerationEventStreamParser(
  input: ProjectCreateCollaborationGroupDraftInput,
  onEvent?: (event: ProjectCreateCollaborationGroupGenerationEvent) => void
) {
  const allowed = allowedParticipantKeys(input)
  let buffer = ''
  let cursor = 0
  let inString = false
  let escaped = false
  let stringStart = -1
  let pendingString: string | null = null
  let expectingEventsArray = false
  let eventsArrayActive = false
  let eventStart = -1
  const containers: Array<'object' | 'array'> = []
  const emittedEvents: ProjectCreateCollaborationGroupGenerationEvent[] = []
  let parseError: Error | null = null

  const emitEvent = (source: string) => {
    if (parseError) return
    try {
      const event = parseGenerationEvent(parseJsonObject(source), allowed)
      emittedEvents.push(event)
      onEvent?.(event)
    } catch (cause) {
      parseError = cause instanceof Error ? cause : new Error(String(cause))
    }
  }

  const scan = () => {
    while (cursor < buffer.length && !parseError) {
      const character = buffer[cursor]!
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (character === '\\') {
          escaped = true
        } else if (character === '"') {
          inString = false
          try {
            pendingString = JSON.parse(buffer.slice(stringStart, cursor + 1))
          } catch {
            parseError = new Error('AI 返回了无效的协作小组结构化结果')
          }
        }
        cursor += 1
        continue
      }
      if (character === '"') {
        inString = true
        stringStart = cursor
        cursor += 1
        continue
      }
      if (/\s/.test(character)) {
        cursor += 1
        continue
      }
      if (character === ':') {
        expectingEventsArray =
          containers.length === 1 && containers[0] === 'object' && pendingString === 'events'
        pendingString = null
        cursor += 1
        continue
      }
      if (character === '{') {
        if (
          eventsArrayActive &&
          containers.length === 2 &&
          containers[0] === 'object' &&
          containers[1] === 'array'
        ) {
          eventStart = cursor
        }
        containers.push('object')
        pendingString = null
        cursor += 1
        continue
      }
      if (character === '}') {
        const completesEvent =
          eventStart >= 0 &&
          eventsArrayActive &&
          containers.length === 3 &&
          containers[2] === 'object'
        if (containers.pop() !== 'object') {
          parseError = new Error('AI 返回了无效的协作小组结构化结果')
          continue
        }
        if (completesEvent) {
          emitEvent(buffer.slice(eventStart, cursor + 1))
          eventStart = -1
        }
        pendingString = null
        cursor += 1
        continue
      }
      if (character === '[') {
        const opensEventsArray =
          expectingEventsArray && containers.length === 1 && containers[0] === 'object'
        containers.push('array')
        if (opensEventsArray) eventsArrayActive = true
        expectingEventsArray = false
        pendingString = null
        cursor += 1
        continue
      }
      if (character === ']') {
        const closesEventsArray =
          eventsArrayActive &&
          containers.length === 2 &&
          containers[0] === 'object' &&
          containers[1] === 'array'
        if (containers.pop() !== 'array') {
          parseError = new Error('AI 返回了无效的协作小组结构化结果')
          continue
        }
        if (closesEventsArray) eventsArrayActive = false
        pendingString = null
        cursor += 1
        continue
      }
      if (character === ',') pendingString = null
      cursor += 1
    }
  }

  return {
    push(delta: string) {
      buffer += delta
      scan()
    },
    finish(finalEvents: ProjectCreateCollaborationGroupGenerationEvent[]) {
      if (parseError) {
        console.warn(
          '[CollaborationGroupGeneration] streamed preview parse failed; using validated final response',
          parseError
        )
      }
      finalEvents.slice(emittedEvents.length).forEach(event => onEvent?.(event))
    },
  }
}

function parseGenerationResponse(
  content: string,
  input: ProjectCreateCollaborationGroupDraftInput
): ProjectCreateCollaborationGroupGenerationEvent[] {
  const response = parseJsonObject(content)
  const rawEvents = Array.isArray(response.events) ? response.events : null
  if (!rawEvents) {
    throw new Error('AI 返回的协作小组结果缺少事件列表')
  }
  const allowed = allowedParticipantKeys(input)
  return rawEvents.map(event => parseGenerationEvent(event, allowed))
}

function collaborationGroupOutputSchema(input: ProjectCreateCollaborationGroupDraftInput) {
  const participantEventSchema = (
    type: 'participant_started' | 'participant_delta',
    kind: 'human' | 'agent',
    ids: string[]
  ) => ({
    type: 'object',
    properties: {
      type: { type: 'string', enum: [type] },
      kind: { type: 'string', enum: [kind] },
      id: { type: 'string', enum: ids },
      ...(type === 'participant_started'
        ? { leader: { type: 'boolean' } }
        : { delta: { type: 'string' } }),
    },
    required:
      type === 'participant_started'
        ? ['type', 'kind', 'id', 'leader']
        : ['type', 'kind', 'id', 'delta'],
    additionalProperties: false,
  })
  const humanIds = [
    String(input.currentUser.id),
    ...input.members.map(member => String(member.user_id)),
  ]
  const agentIds = input.agents.map(agent => agent.id)
  const participantEvents = (['participant_started', 'participant_delta'] as const).flatMap(
    type => [
      ...(humanIds.length > 0 ? [participantEventSchema(type, 'human', humanIds)] : []),
      ...(agentIds.length > 0 ? [participantEventSchema(type, 'agent', agentIds)] : []),
    ]
  )
  return {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['group'] },
                name: { type: 'string' },
              },
              required: ['type', 'name'],
              additionalProperties: false,
            },
            ...participantEvents,
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['principle'] },
                text: { type: 'string' },
              },
              required: ['type', 'text'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['stage'] },
                id: { type: 'string' },
                name: { type: 'string' },
              },
              required: ['type', 'id', 'name'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ['events'],
    additionalProperties: false,
  }
}

export function parseCollaborationGroupDraft(
  content: string,
  input: ProjectCreateCollaborationGroupDraftInput
): ProjectCreateCollaborationGroupDraft {
  const events = parseGenerationResponse(content, input)
  const selectedParticipants = [
    { kind: 'human' as const, id: String(input.currentUser.id) },
    ...input.members.map(member => ({ kind: 'human' as const, id: String(member.user_id) })),
    ...input.agents.map(agent => ({ kind: 'agent' as const, id: agent.id })),
  ]
  const responsibilities = new Map<string, string>()
  events.forEach(event => {
    if (event.type !== 'participant_delta') return
    const key = `${event.kind}:${event.id}`
    responsibilities.set(key, `${responsibilities.get(key) ?? ''}${event.delta}`)
  })
  const requestedLeader = events.find(event => event.type === 'participant_started' && event.leader)
  const preferredLeaderId = currentDeviceAgentId(input)
  const fallbackLeader =
    selectedParticipants.find(
      participant => participant.kind === 'agent' && participant.id === preferredLeaderId
    ) ??
    selectedParticipants.find(participant => participant.kind === 'agent') ??
    selectedParticipants[0]
  if (!fallbackLeader) {
    throw new Error('当前项目没有可加入协作小组的成员')
  }
  const leaderIdentity =
    requestedLeader?.type === 'participant_started'
      ? { kind: requestedLeader.kind, id: requestedLeader.id }
      : fallbackLeader
  const leader = {
    ...leaderIdentity,
    responsibility: '',
  }
  const members = selectedParticipants
    .filter(participant => participant.kind !== leader.kind || participant.id !== leader.id)
    .map(participant => ({
      ...participant,
      responsibility: responsibilities.get(`${participant.kind}:${participant.id}`) ?? '',
    }))
  const stages = events
    .filter(event => event.type === 'stage')
    .filter((stage, index, all) => all.findIndex(candidate => candidate.id === stage.id) === index)
    .map(stage => ({
      id: stage.id,
      name: stage.name,
      description: '',
      assignee: null,
    }))
  const group = events.find(event => event.type === 'group')
  const principles = events.filter(event => event.type === 'principle').map(event => event.text)
  return {
    name:
      (group?.type === 'group' ? group.name : '') || `${input.projectName || '未命名项目'}协作小组`,
    description: input.projectDescription,
    instructions: principles.join('\n'),
    leader,
    members,
    stages,
    executionRequirements: { requiredTags: [] },
  }
}

export async function generateCollaborationGroupDraft(options: {
  input: ProjectCreateCollaborationGroupDraftInput
  textGenerationApi?: TextGenerationApi
  onProgress?: (phase: 'preparing' | 'generating') => void
  onEvent?: (event: ProjectCreateCollaborationGroupGenerationEvent) => void
}): Promise<ProjectCreateCollaborationGroupDraft> {
  if (!options.textGenerationApi) {
    throw new Error('当前设备不支持生成协作分工')
  }
  const { input } = options
  const preferredLeaderId = currentDeviceAgentId(input)
  const collaborators = [
    {
      kind: 'human',
      id: String(input.currentUser.id),
      name: input.currentUser.name,
      capability: '项目发起人，负责目标确认、决策和验收',
    },
    ...input.members.map(member => ({
      kind: 'human',
      id: String(member.user_id),
      name: member.user_name,
      capability: member.capability_description || '项目成员',
    })),
    ...input.agents.map(agent => ({
      kind: 'agent',
      id: agent.id,
      name: agent.name,
      capability: agent.systemPrompt || agent.runtime || '通用智能体',
    })),
  ]
  const eventParser = createGenerationEventStreamParser(input, options.onEvent)
  const prompt = [
    '你是项目协作架构师。请为以下新项目生成一个可直接执行的协作小组分工。',
    '输出必须严格匹配系统提供的 JSON Schema，只输出一个 JSON 对象，禁止输出 Markdown、说明文字或思考过程。',
    '顶层对象只包含 events。events 严格按以下顺序排列：group；每个成员依次输出 participant_started 和多个 participant_delta；2 到 3 个 principle；2 到 4 个 stage。',
    'participant_started 结构：{"type":"participant_started","kind":"human|agent","id":"string","leader":true|false}。',
    'participant_delta 结构：{"type":"participant_delta","kind":"human|agent","id":"string","delta":"职责片段"}。将每个成员职责拆成 2 到 4 个语义完整的短片段逐行输出。',
    'group 结构：{"type":"group","name":"string"}。',
    'principle 结构：{"type":"principle","text":"string"}。每条只表达一个规则。',
    'stage 结构：{"type":"stage","id":"string","name":"string"}。',
    '必须严格使用给定的 kind 和 id，不得新增、删除或重复协作者。',
    'leader 只负责拆解、分派、验收、综合判断和更新 Issue 状态，不得执行任何成员任务；leader 的 participant_delta 只描述协调职责。',
    '每个成员的 responsibility 必须精炼、具体且可执行，避免重复项目背景和分配原则。',
    '每条 principle 只表达一个规则；只保留负责人如何分派、成员如何反馈、阻塞如何升级，不要重复项目背景、职责或执行流程。',
    preferredLeaderId
      ? `优先让 agent:${preferredLeaderId} 担任 leader，因为它是当前设备智能体且具备通用执行能力。`
      : '从现有协作者中选择最适合拆解、分派和验收工作的 leader；人类和智能体都可以担任 leader。',
    '每个协作者都必须输出一次 participant_started，并紧接着输出其全部 participant_delta。',
    '生成 2 到 4 个阶段。',
    '所有 name、delta、text 字段必须使用与“用户补充要求”相同的语言书写（Use the language of the user request for all generated text）。',
    '',
    `项目名称：${input.projectName || '未命名项目'}`,
    `项目说明：${input.projectDescription || '暂无说明，请按通用项目协作设计'}`,
    `用户补充要求：${input.generationInstructions || '无，请根据项目和协作者能力自动设计'}`,
    `协作者：${JSON.stringify(collaborators)}`,
  ].join('\n')
  const content = await options.textGenerationApi.generateText({
    title: '生成项目协作小组分工',
    prompt,
    modelId: input.modelSelection.modelName,
    modelType: input.modelSelection.modelType,
    modelOptions: input.modelSelection.options,
    outputSchema: collaborationGroupOutputSchema(input),
    onProgress: phase => options.onProgress?.(phase),
    onDelta: delta => eventParser.push(delta),
  })
  const events = parseGenerationResponse(content, input)
  eventParser.finish(events)
  const draft = parseCollaborationGroupDraft(content, input)
  return draft
}
