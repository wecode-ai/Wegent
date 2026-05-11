import {
  buildPipelineNextStepDraft,
  buildPipelineNextStepPayload,
  type BuildPipelineNextStepPayloadInput,
  type PipelineNextStepMessage,
} from '@/features/tasks/components/chat/pipelineNextStep'

const userMessage = (
  overrides: Partial<PipelineNextStepMessage> = {}
): PipelineNextStepMessage => ({
  id: 'user-1',
  type: 'user',
  status: 'completed',
  content: 'Original request',
  timestamp: 1,
  contexts: [
    {
      id: 10,
      context_type: 'attachment',
      name: 'spec.md',
      status: 'ready',
      file_extension: 'md',
      file_size: 100,
      mime_type: 'text/markdown',
    },
    {
      id: 200,
      context_type: 'knowledge_base',
      name: 'Product KB',
      status: 'ready',
      knowledge_id: 20,
      document_count: 3,
    },
  ],
  ...overrides,
})

const aiMessage = (
  content: string,
  overrides: Partial<PipelineNextStepMessage> = {}
): PipelineNextStepMessage => ({
  id: 'ai-1',
  type: 'ai',
  status: 'completed',
  content,
  timestamp: 2,
  contexts: [
    {
      id: 300,
      context_type: 'table',
      name: 'Roadmap',
      status: 'ready',
      document_id: 30,
      source_config: { url: 'https://example.com/table' },
    },
  ],
  ...overrides,
})

const payloadInput = (
  input: BuildPipelineNextStepPayloadInput
): BuildPipelineNextStepPayloadInput => input

describe('pipeline next-step helpers', () => {
  it('uses final_prompt as the default AI context when available', () => {
    const draft = buildPipelineNextStepDraft([
      userMessage(),
      aiMessage(['## Final Requirement Prompt', 'Ship the next-step dialog.'].join('\n')),
    ])

    expect(draft.defaultMessage).toBe('')
    expect(draft.defaultSource).toBe('final_prompt')
    expect(draft.canSubmit).toBe(true)
    expect(draft.textItems).toEqual([
      expect.objectContaining({
        kind: 'user_message',
        role: 'user',
        content: 'Original request',
        selectedByDefault: false,
      }),
      expect.objectContaining({
        kind: 'ai_response',
        role: 'ai',
        content: 'Ship the next-step dialog.',
        selectedByDefault: true,
      }),
    ])
  })

  it('falls back to the last completed AI response as selected context', () => {
    const draft = buildPipelineNextStepDraft([userMessage(), aiMessage('Plain AI summary')])

    expect(draft.defaultMessage).toBe('')
    expect(draft.defaultSource).toBe('last_ai_response')
    expect(draft.textItems.find(item => item.kind === 'ai_response')).toMatchObject({
      role: 'ai',
      content: 'Plain AI summary',
      selectedByDefault: true,
    })
  })

  it('returns selectable text context items without duplicating the main message', () => {
    const draft = buildPipelineNextStepDraft([
      userMessage({
        id: 'history-user',
        content: 'Earlier request',
        timestamp: 1,
        contexts: [],
      }),
      userMessage({ timestamp: 2 }),
      aiMessage('Plain AI summary'),
    ])

    expect(draft.textItems.map(item => item.kind)).toEqual([
      'history_message',
      'user_message',
      'ai_response',
    ])
    expect(Object.keys(draft.textItems[0]).sort()).toEqual([
      'content',
      'id',
      'kind',
      'role',
      'selectedByDefault',
    ])
  })

  it('deduplicates structured contexts from the current user and AI pair', () => {
    const draft = buildPipelineNextStepDraft([
      userMessage({
        contexts: [
          {
            id: 10,
            context_type: 'attachment',
            name: 'spec.md',
            status: 'ready',
          },
          {
            id: 10,
            context_type: 'attachment',
            name: 'spec.md',
            status: 'ready',
          },
        ],
      }),
      aiMessage('Plain AI summary'),
    ])

    expect(draft.structuredItems.map(item => `${item.context.context_type}:${item.id}`)).toEqual([
      'attachment:attachment:10',
      'table:table:30',
    ])
  })

  it('uses timestamp as a tie-breaker for user and AI messages with the same messageId', () => {
    const draft = buildPipelineNextStepDraft([
      aiMessage('Plain AI summary', {
        messageId: 100,
        timestamp: 2,
      }),
      userMessage({
        messageId: 100,
        timestamp: 1,
      }),
    ])

    expect(draft.textItems.find(item => item.kind === 'user_message')).toMatchObject({
      content: 'Original request',
      role: 'user',
      selectedByDefault: false,
    })
    expect(draft.textItems.find(item => item.kind === 'ai_response')).toMatchObject({
      content: 'Plain AI summary',
      role: 'ai',
      selectedByDefault: true,
    })
    expect(draft.structuredItems.map(item => `${item.context.context_type}:${item.id}`)).toEqual([
      'attachment:attachment:10',
      'knowledge_base:knowledge_base:20',
      'table:table:30',
    ])
  })

  it('returns a disabled draft when no usable AI message exists', () => {
    const draft = buildPipelineNextStepDraft([
      userMessage(),
      aiMessage('', {
        id: 'empty-ai',
        content: '   ',
      }),
    ])

    expect(draft.defaultMessage).toBe('')
    expect(draft.defaultSource).toBe('none')
    expect(draft.canSubmit).toBe(false)
    expect(draft.textItems).toEqual([])
    expect(draft.structuredItems).toEqual([])
  })

  it('ignores non-completed AI messages in favor of the last completed AI message', () => {
    const draft = buildPipelineNextStepDraft([
      userMessage(),
      aiMessage('Completed answer', {
        id: 'completed-ai',
        timestamp: 2,
      }),
      aiMessage('Pending answer', {
        id: 'pending-ai',
        status: 'pending',
        timestamp: 3,
      }),
      aiMessage('Streaming answer', {
        id: 'streaming-ai',
        status: 'streaming',
        timestamp: 4,
      }),
      aiMessage('Error answer', {
        id: 'error-ai',
        status: 'error',
        timestamp: 5,
      }),
    ])

    expect(draft.defaultMessage).toBe('')
    expect(draft.defaultSource).toBe('last_ai_response')
    expect(draft.textItems.find(item => item.kind === 'ai_response')).toMatchObject({
      content: 'Completed answer',
      role: 'ai',
      selectedByDefault: true,
    })
  })

  it('builds backend payload from selected text and structured contexts with role labels', () => {
    const draft = buildPipelineNextStepDraft([userMessage(), aiMessage('Plain AI summary')])
    const payload = buildPipelineNextStepPayload(
      payloadInput({
        draft,
        editedMessage: 'Edited handoff',
        selectedTextItemIds: draft.textItems.map(item => item.id),
        selectedStructuredItemIds: draft.structuredItems.map(item => item.id),
      })
    )

    expect(payload.message).toContain('Edited handoff')
    expect(payload.message).toContain('Previous pipeline context:')
    expect(payload.message).toContain('[User]\nOriginal request')
    expect(payload.message).toContain('[AI]\nPlain AI summary')
    expect(payload.attachmentIds).toEqual([10])
    expect(payload.contexts).toEqual([
      {
        type: 'knowledge_base',
        data: {
          knowledge_id: 20,
          name: 'Product KB',
          document_count: 3,
        },
      },
      {
        type: 'table',
        data: {
          document_id: 30,
          name: 'Roadmap',
          source_config: { url: 'https://example.com/table' },
        },
      },
    ])
    expect(payload.pendingContexts).toHaveLength(3)
  })

  it('does not expose knowledge base or table contexts without domain IDs', () => {
    const draft = buildPipelineNextStepDraft([
      userMessage({
        contexts: [
          {
            id: 200,
            context_type: 'knowledge_base',
            name: 'Legacy KB context',
            status: 'ready',
          },
          {
            id: 300,
            context_type: 'table',
            name: 'Legacy table context',
            status: 'ready',
          },
        ],
      }),
      aiMessage('Plain AI summary', { contexts: [] }),
    ])

    expect(draft.structuredItems).toEqual([])
  })
})
