import {
  buildPipelineNextStepDraft,
  buildPipelineNextStepPayload,
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
      id: 20,
      context_type: 'knowledge_base',
      name: 'Product KB',
      status: 'ready',
      document_count: 3,
    },
  ],
  ...overrides,
})

const aiMessage = (content: string): PipelineNextStepMessage => ({
  id: 'ai-1',
  type: 'ai',
  status: 'completed',
  content,
  timestamp: 2,
  contexts: [
    {
      id: 30,
      context_type: 'table',
      name: 'Roadmap',
      status: 'ready',
      source_config: { url: 'https://example.com/table' },
    },
  ],
})

describe('pipeline next-step helpers', () => {
  it('uses final_prompt as the default message when available', () => {
    const draft = buildPipelineNextStepDraft([
      userMessage(),
      aiMessage(['## Final Requirement Prompt', 'Ship the next-step dialog.'].join('\n')),
    ])

    expect(draft.defaultMessage).toBe('Ship the next-step dialog.')
    expect(draft.defaultSource).toBe('final_prompt')
    expect(draft.canSubmit).toBe(true)
  })

  it('falls back to the last completed AI response when final_prompt is missing', () => {
    const draft = buildPipelineNextStepDraft([userMessage(), aiMessage('Plain AI summary')])

    expect(draft.defaultMessage).toBe('Plain AI summary')
    expect(draft.defaultSource).toBe('last_ai_response')
    expect(draft.textItems.find(item => item.kind === 'ai_response')).toMatchObject({
      kind: 'ai_response',
      label: 'AI response',
      selectedByDefault: true,
      includedInMainMessage: true,
    })
  })

  it('returns the planned public text item shape with labels', () => {
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
      'user_message',
      'ai_response',
      'history_message',
    ])
    expect(draft.textItems.map(item => item.label)).toEqual([
      'User message',
      'AI response',
      'History message',
    ])
    expect(Object.keys(draft.textItems[0]).sort()).toEqual([
      'content',
      'id',
      'includedInMainMessage',
      'kind',
      'label',
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

    expect(
      draft.structuredItems.map(item => `${item.context.context_type}:${item.context.id}`)
    ).toEqual(['attachment:10', 'table:30'])
  })

  it('builds backend payload from selected text and structured contexts', () => {
    const draft = buildPipelineNextStepDraft([userMessage(), aiMessage('Plain AI summary')])
    const payload = buildPipelineNextStepPayload({
      draft,
      editedMessage: 'Edited handoff',
      selectedTextItemIds: draft.textItems.map(item => item.id),
      selectedStructuredItemIds: draft.structuredItems.map(item => item.id),
    })

    expect(payload.message).toContain('Edited handoff')
    expect(payload.message).toContain('Original request')
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
})
