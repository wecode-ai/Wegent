// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import {
  generateCollaborationGroupDraft,
  parseCollaborationGroupDraft,
} from './collaborationGroupDraftGeneration'

const input = {
  projectName: '发布工作台',
  projectDescription: '完成设计、开发和验收',
  generationInstructions: '设备智能体负责核心实现，设计智能体负责交互',
  currentUser: { id: 7, name: '项目发起人' },
  modelSelection: {
    modelName: 'gpt-5.6-sol',
    modelType: 'runtime' as const,
    options: { reasoning: 'low' },
  },
  members: [],
  agents: [
    {
      id: 'device-agent',
      name: '当前设备智能体',
      owner_type: 'workspace' as const,
      owner_id: 'local',
      owner_name: '本地空间',
      status: 'available' as const,
      execution_environment_ids: [],
      project_binding_input: { name: 'current-device-agent' },
    },
    {
      id: 'design-agent',
      name: '设计智能体',
      owner_type: 'workspace' as const,
      owner_id: 'local',
      owner_name: '本地空间',
      status: 'available' as const,
      execution_environment_ids: [],
    },
  ],
}

const generatedEvents = [
  { type: 'group', name: '发布协作小组' },
  {
    type: 'participant_started',
    kind: 'agent',
    id: 'device-agent',
    leader: true,
  },
  {
    type: 'participant_responsibility',
    kind: 'agent',
    id: 'device-agent',
    text: '协调任务并',
  },
  {
    type: 'participant_responsibility',
    kind: 'agent',
    id: 'device-agent',
    text: '完成核心开发',
  },
  {
    type: 'participant_started',
    kind: 'human',
    id: '7',
    leader: false,
  },
  {
    type: 'participant_responsibility',
    kind: 'human',
    id: '7',
    text: '确认目标并验收',
  },
  {
    type: 'participant_started',
    kind: 'agent',
    id: 'design-agent',
    leader: false,
  },
  {
    type: 'participant_responsibility',
    kind: 'agent',
    id: 'design-agent',
    text: '负责交互设计',
  },
  { type: 'principle', text: '负责人拆解任务并参与实现' },
  { type: 'principle', text: '成员及时反馈进展和阻塞' },
  { type: 'stage', id: 'plan', name: '方案' },
]

function generationResponse(events = generatedEvents) {
  return JSON.stringify({ events })
}

const generated = generationResponse()

describe('collaborationGroupDraftGeneration', () => {
  it('keeps the coordinating lead out of execution responsibilities and covers every collaborator', () => {
    expect(parseCollaborationGroupDraft(generated, input)).toMatchObject({
      leader: {
        kind: 'agent',
        id: 'device-agent',
        name: '当前设备智能体',
        responsibility: '',
      },
      members: [
        { kind: 'human', id: '7', name: '项目发起人' },
        { kind: 'agent', id: 'design-agent', name: '设计智能体' },
      ],
    })
  })

  it('keeps missing collaborators editable instead of rejecting the draft', () => {
    const incomplete = generationResponse(
      generatedEvents.filter(event => !('id' in event) || event.id !== 'design-agent')
    )
    expect(parseCollaborationGroupDraft(incomplete, input).members).toContainEqual({
      kind: 'agent',
      id: 'design-agent',
      name: '设计智能体',
      responsibility: '',
    })
  })

  it('asks the selected model for a strict project group draft', async () => {
    const onProgress = vi.fn()
    const onEvent = vi.fn()
    const generateText = vi.fn(async options => {
      options.onProgress?.('generating')
      const splitAt = Math.floor(generated.length / 2)
      options.onDelta?.(generated.slice(0, splitAt))
      options.onDelta?.(generated.slice(splitAt))
      return generated
    })
    await expect(
      generateCollaborationGroupDraft({
        input,
        textGenerationApi: { generateText },
        onProgress,
        onEvent,
      })
    ).resolves.toMatchObject({ name: '发布协作小组' })

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gpt-5.6-sol',
        prompt: expect.stringContaining('agent:device-agent'),
        outputSchema: expect.objectContaining({
          type: 'object',
          required: ['events'],
        }),
      })
    )
    expect(generateText.mock.calls[0]?.[0].outputSchema.properties).not.toHaveProperty('result')
    expect(generateText.mock.calls[0]?.[0].prompt).toContain('不得执行任何成员任务')
    expect(generateText.mock.calls[0]?.[0].prompt).toContain('2 到 3 个 principle')
    expect(generateText.mock.calls[0]?.[0].prompt).toContain('Use the language of the user request')
    expect(generateText.mock.calls[0]?.[0].prompt).not.toContain('总计不超过')
    expect(generateText.mock.calls[0]?.[0].prompt).toContain(
      '设备智能体负责核心实现，设计智能体负责交互'
    )
    expect(onProgress).toHaveBeenNthCalledWith(1, 'generating')
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenLastCalledWith('generating')
    expect(onEvent).toHaveBeenCalledWith({
      type: 'participant_responsibility',
      kind: 'agent',
      id: 'device-agent',
      text: '协调任务并',
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'principle',
      text: '负责人拆解任务并参与实现',
    })
  })

  it('rejects unknown participant ids from streamed events', async () => {
    const invalid = [
      {
        type: 'participant_started',
        kind: 'agent',
        id: 'unknown-agent',
        leader: true,
      },
    ]
    const invalidResponse = JSON.stringify({
      events: invalid,
    })
    const generateText = vi.fn(async options => {
      options.onDelta?.(invalidResponse)
      return invalidResponse
    })

    await expect(
      generateCollaborationGroupDraft({
        input,
        textGenerationApi: { generateText },
      })
    ).rejects.toThrow('不在当前项目中的协作者事件')
  })

  it('uses a valid final response when a streamed preview is incomplete', async () => {
    const onEvent = vi.fn()
    const generateText = vi.fn(async options => {
      options.onDelta?.('{"events":[{"type":"group","name":"截断')
      return generated
    })

    await expect(
      generateCollaborationGroupDraft({
        input,
        textGenerationApi: { generateText },
        onEvent,
      })
    ).resolves.toMatchObject({ name: '发布协作小组' })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'participant_started',
      kind: 'agent',
      id: 'device-agent',
      leader: true,
    })
  })
})

const responsibilityCases = [
  ['Confirm acceptance criteria', 'Resolve blockers'],
  ['确认验收条件', '处理阻塞问题'],
]

function responsibilityResponse(items: string[]) {
  return JSON.stringify({
    events: [
      { type: 'group', name: ' Group ' },
      { type: 'participant_started', kind: 'agent', id: ' device-agent ', leader: true },
      { type: 'participant_started', kind: 'human', id: ' 7 ', leader: false },
      ...items.map(text => ({
        type: 'participant_responsibility',
        kind: 'human',
        id: ' 7 ',
        text,
      })),
      { type: 'principle', text: 'Assign work and review evidence' },
      { type: 'stage', id: ' review ', name: ' Review ' },
    ],
  })
}

it.each(responsibilityCases)(
  'separates complete items %s / %s without relying on punctuation or spaces',
  (first, second) => {
    const draft = parseCollaborationGroupDraft(responsibilityResponse([first, second]), input)
    expect(draft.name).toBe('Group')
    expect(draft.members.find(member => member.id === '7')?.responsibility).toBe(
      [first, second].join('\n')
    )
    expect(draft.stages[0]).toMatchObject({ id: 'review', name: 'Review' })
  }
)

it.each([true, false])(
  'keeps streamed preview and final independent items consistent (streamed=%s)',
  async streamed => {
    const items = [
      ' Confirm acceptance criteria ',
      '\tResolve blockers\u00a0',
      '反馈实际结果\n保留验证证据',
    ]
    const normalized = items.map(text => text.trim())
    const onEvent = vi.fn()
    const content = responsibilityResponse(items)
    const generateText = vi.fn(async options => {
      if (streamed) {
        for (let index = 0; index < content.length; index += 7)
          options.onDelta?.(content.slice(index, index + 7))
        expect(
          onEvent.mock.calls
            .map(([event]) => event)
            .filter(event => event.type === 'participant_responsibility')
            .map(event => event.text)
        ).toEqual(normalized)
      }
      return content
    })
    const draft = await generateCollaborationGroupDraft({
      input,
      textGenerationApi: { generateText },
      onEvent,
    })
    const responsibilities = onEvent.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'participant_responsibility')
      .map(event => event.text)
    expect(responsibilities).toEqual(normalized)
    expect(draft.members.find(member => member.id === '7')?.responsibility).toBe(
      responsibilities.join('\n')
    )
    const request = generateText.mock.calls[0]![0]
    expect(request.prompt).toContain('每个事件表达一个完整、独立、可执行的职责条目')
    expect(request.prompt).not.toContain('participant_delta')
    const schema = JSON.stringify(request.outputSchema)
    expect(schema).toContain('participant_responsibility')
    expect(schema).not.toContain('participant_delta')
  }
)

it.each(['', ' \n\t ', null, 42])('rejects an empty or invalid responsibility item %j', text => {
  const response = JSON.stringify({
    events: [{ type: 'participant_responsibility', kind: 'human', id: '7', text }],
  })
  expect(() => parseCollaborationGroupDraft(response, input)).toThrow('缺少职责条目')
})

it.each([
  { omitted: ['principle'], missingSections: ['principles'] },
  { omitted: ['stage'], missingSections: ['stages'] },
  { omitted: ['principle', 'stage'], missingSections: ['principles', 'stages'] },
])(
  'rejects final generation missing $missingSections while preserving streamed responsibilities',
  async ({ omitted, missingSections }) => {
    const content = generationResponse(
      generatedEvents.filter(event => !omitted.includes(event.type))
    )
    const onEvent = vi.fn()
    const generateText = vi.fn(async options => {
      options.onDelta?.(content)
      return content
    })
    await expect(
      generateCollaborationGroupDraft({ input, textGenerationApi: { generateText }, onEvent })
    ).rejects.toMatchObject({
      name: 'IncompleteCollaborationGroupGenerationError',
      missingSections,
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'participant_responsibility', kind: 'human', id: '7' })
    )
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(() => parseCollaborationGroupDraft(content, input)).not.toThrow()
  }
)
