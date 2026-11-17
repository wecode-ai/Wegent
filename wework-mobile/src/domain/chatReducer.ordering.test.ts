import { describe, expect, it } from 'vitest'
import { chatReducer, type ChatAction } from '../../test/chatHarness'
import { hydrateRuntimeTranscript } from '../../test/chatHarness'
import type { RuntimeTranscriptResponse } from '@/types/runtime'

const assistant = {
  id: 'runtime-view:turn:assistant',
  role: 'assistant',
  subtaskId: 'turn',
  content: 'Reply',
  status: 'streaming',
  runtimeItems: [{ id: 'text', type: 'assistant_text' as const, content: 'Reply' }],
}
const user = {
  id: 'provider-user',
  clientUserMessageId: 'client-user',
  subtaskId: 'turn',
  role: 'user',
  content: 'Question',
}
const delta: ChatAction = {
  type: 'stream',
  event: {
    name: 'response.output_text.delta',
    payload: {
      subtaskId: 'turn',
      clientUserMessageId: 'client-user',
      data: { itemId: 'text', delta: '!', offset: 5 },
    },
  },
}

describe('live user and assistant order', () => {
  it('starts a separate assistant view after a new user boundary within the same runtime turn', () => {
    let messages = chatReducer([], {
      type: 'replace',
      messages: [
        { id: 'old-user', role: 'user', content: 'Old question', subtaskId: 'turn' },
        {
          ...assistant,
          content: 'Old reply',
          status: 'completed',
          runtimeItems: [{ id: 'old-text', type: 'assistant_text', content: 'Old reply' }],
        },
      ],
    })
    messages = chatReducer(messages, {
      type: 'optimistic-user',
      id: 'client-user',
      content: 'Question',
      createdAt: 1000,
    })
    messages = chatReducer(messages, {
      type: 'stream',
      event: {
        name: 'response.guidance.applied',
        payload: {
          subtaskId: 'turn',
          data: {
            guidanceId: 'client-user',
            clientGuidanceId: 'client-user',
            message: 'Question',
            appliedAtMs: 1000,
          },
        },
      },
    })
    messages = chatReducer(messages, {
      type: 'stream',
      event: {
        name: 'response.output_text.delta',
        payload: {
          subtaskId: 'turn',
          clientUserMessageId: 'client-user',
          data: { itemId: 'new-text', delta: 'New reply', offset: 0 },
        },
      },
    })
    expect(messages.map(message => message.content)).toEqual([
      'Old question',
      'Old reply',
      'Question',
      'New reply',
    ])
    expect(messages.at(-1)?.id).toBe('runtime-view:turn:after:client-user')
  })

  it('splits at a guidance user before its first new assistant item while late items retain ownership', () => {
    const initial = chatReducer([], {
      type: 'replace',
      messages: [
        assistant,
        {
          id: 'guide',
          runtimeItemId: 'native-guide',
          role: 'user',
          content: 'Guidance',
          subtaskId: 'turn',
        },
      ],
    })
    const continued = chatReducer(initial, {
      type: 'stream',
      event: {
        name: 'response.output_text.delta',
        payload: {
          subtaskId: 'turn',
          data: { itemId: 'after-guidance', delta: 'Continued', offset: 0 },
        },
      },
    })
    const late = chatReducer(continued, {
      type: 'stream',
      event: {
        name: 'response.output_text.delta',
        payload: { subtaskId: 'turn', data: { itemId: 'text', delta: '!', offset: 5 } },
      },
    })
    expect(late.map(message => message.content)).toEqual(['Reply!', 'Guidance', 'Continued'])
    expect(late.at(-1)?.id).toBe('runtime-view:turn:after:native-guide')
  })
  it('uses canonical snapshot order when the reply was observed before its user message', () => {
    const live = chatReducer([], { type: 'replace', messages: [assistant] })
    const merged = chatReducer(live, { type: 'merge-latest', messages: [user, assistant] })
    expect(merged.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(merged[0].id).toBe('client-user')
  })

  it('retains older loaded messages before a canonical live tail', () => {
    const previous = chatReducer([], {
      type: 'replace',
      messages: [
        { id: 'history-user', subtaskId: 'history-reply', role: 'user', content: 'Old question' },
        { id: 'history-reply', role: 'assistant', content: 'Old reply' },
        assistant,
      ],
    })
    const merged = chatReducer(previous, { type: 'merge-latest', messages: [user, assistant] })
    expect(merged.map(message => message.content)).toEqual([
      'Old question',
      'Old reply',
      'Question',
      'Reply',
    ])
  })

  it('binds a buffered optimistic user before its exact reply when history finishes during send', () => {
    const transcript: RuntimeTranscriptResponse = {
      taskId: 'task',
      workspacePath: '/work',
      runtime: 'codex',
      messages: [assistant],
    }
    const result = hydrateRuntimeTranscript(
      [],
      transcript,
      [
        { type: 'optimistic-user', id: 'client-user', content: 'Question', createdAt: 1000 },
        {
          type: 'stream',
          event: {
            name: 'response.created',
            payload: { subtaskId: 'turn', clientUserMessageId: 'client-user', data: {} },
          },
        },
        delta,
      ],
      false
    )
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(result.messages[1].content).toBe('Reply!')
    expect(result.messages[0]).toMatchObject({
      id: 'client-user',
      subtaskId: 'turn',
      turnId: 'turn',
    })
  })

  it('does not attach an unrelated queued user to an autonomous reply', () => {
    const transcript: RuntimeTranscriptResponse = {
      taskId: 'task',
      workspacePath: '/work',
      runtime: 'codex',
      messages: [assistant],
    }
    const result = hydrateRuntimeTranscript(
      [],
      transcript,
      [
        {
          type: 'optimistic-user',
          id: 'different-user',
          content: 'Queued question',
          createdAt: 1000,
        },
        delta,
      ],
      false
    )
    expect(result.messages.find(message => message.id === 'different-user')).not.toHaveProperty(
      'turnId'
    )
    expect(result.messages.map(message => message.role)).toEqual(['assistant', 'user'])
  })
})
