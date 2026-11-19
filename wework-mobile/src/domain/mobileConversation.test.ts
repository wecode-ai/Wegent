import { describe, expect, it } from 'vitest'
import { MobileConversation } from './mobileConversation'
import { projectMobileRuntimeTranscript } from './runtimeTranscript'
import type { RuntimeTranscriptTurn } from '../../../packages/chat-core/src/runtime'

const address = { deviceId: 'device', taskId: 'task' }
const snapshot = (turns: RuntimeTranscriptTurn[], supersededTurnIds: string[] = []) =>
  projectMobileRuntimeTranscript({
    taskId: 'task',
    runtime: 'codex',
    workspacePath: '/work',
    messages: [],
    runtimeTurns: [],
    turns,
    supersededTurnIds,
  })
const text = (id: string, content: string) => ({ id, type: 'assistant_text' as const, content })
const delta = (conversation: MobileConversation, content: string, itemId = 'after') =>
  conversation.dispatch({
    type: 'stream',
    event: {
      name: 'response.output_text.delta',
      payload: { ...address, subtaskId: 'turn', data: { itemId, delta: content } },
    },
  })

describe('PC remote-device conversation parity', () => {
  it('retains buffered final text after a completed view within a still-running guided turn', () => {
    const conversation = new MobileConversation(address)
    const page = snapshot([
      {
        id: 'turn',
        status: 'inProgress',
        items: [
          text('before', 'Inspect'),
          {
            id: 'guide',
            type: 'user_message',
            message: { id: 'guide', role: 'user', content: 'Continue', runtimeGuidance: true },
          },
          text('after', 'Fi'),
        ],
      },
    ])
    conversation.hydrate(page, false)
    conversation.beginHydration()
    delta(conversation, 'xed')
    conversation.hydrate(page, true)
    expect(conversation.messages.map(message => message.content)).toEqual([
      'Inspect',
      'Continue',
      'Fixed',
    ])
    expect(conversation.messages.at(-1)?.status).toBe('streaming')
  })

  it('preserves the final item when a terminal page omits it during a read', () => {
    const conversation = new MobileConversation(address)
    conversation.beginHydration()
    conversation.dispatch({
      type: 'stream',
      event: {
        name: 'response.completed',
        payload: {
          ...address,
          subtaskId: 'turn',
          data: { itemId: 'answer', value: 'Final answer' },
        },
      },
    })
    conversation.hydrate(snapshot([{ id: 'turn', status: 'completed', items: [] }]), false)
    expect(conversation.messages.at(-1)).toMatchObject({
      status: 'completed',
      content: 'Final answer',
    })
  })

  it('clears recovered errors and preserves the reply', () => {
    const conversation = new MobileConversation(address)
    conversation.dispatch({
      type: 'stream',
      event: { name: 'response.created', payload: { subtaskId: 'turn', data: {} } },
    })
    delta(conversation, 'Answer')
    for (const [name, data] of [
      ['response.failed', { error: { message: 'overloaded' } }],
      ['response.recovered', {}],
    ] as const)
      conversation.dispatch({
        type: 'stream',
        event: { name, payload: { ...address, subtaskId: 'turn', data } },
      })
    expect(conversation.messages.at(-1)).toMatchObject({ status: 'completed', content: 'Answer' })
    expect(conversation.messages.at(-1)?.error).toBeUndefined()
  })

  it('presents interruption as cancellation without an error', () => {
    const conversation = new MobileConversation(address)
    conversation.dispatch({
      type: 'stream',
      event: { name: 'response.created', payload: { subtaskId: 'turn', data: {} } },
    })
    delta(conversation, 'Partial')
    conversation.dispatch({
      type: 'stream',
      event: {
        name: 'response.incomplete',
        payload: {
          ...address,
          subtaskId: 'turn',
          data: { type: 'cancelled', error: { message: 'interrupted' } },
        },
      },
    })
    expect(conversation.messages.at(-1)).toMatchObject({
      status: 'completed',
      runtimeStatus: 'cancelled',
      stoppedNotice: true,
    })
    expect(conversation.messages.at(-1)?.error).toBeUndefined()
  })

  it('removes superseded turns and keeps native text/tool order', () => {
    const conversation = new MobileConversation(address)
    conversation.hydrate(
      snapshot([
        { id: 'old', status: 'failed', error: 'old error', items: [text('old-text', 'Old')] },
      ]),
      false
    )
    conversation.beginHydration()
    conversation.hydrate(
      snapshot(
        [
          {
            id: 'turn',
            status: 'completed',
            items: [
              text('one', 'Before'),
              {
                id: 'tool',
                type: 'block',
                block: { id: 'tool', type: 'tool', tool_name: 'bash', status: 'done' },
              },
              text('two', 'After'),
            ],
          },
        ],
        ['old']
      ),
      true
    )
    expect(conversation.messages).toHaveLength(1)
    expect(conversation.messages[0].runtimeDisplayItems?.map(item => item.id)).toEqual([
      'one',
      'tool',
      'two',
    ])
    expect(conversation.messages[0].error).toBeUndefined()
  })
})

it('does not restore an older failed snapshot after a recovery observed during that read', () => {
  const conversation = new MobileConversation(address)
  const failed = snapshot([
    {
      id: 'turn',
      status: 'failed',
      error: 'old quota',
      errorType: 'quota_exceeded',
      items: [text('after', 'Answer')],
    },
  ])
  conversation.hydrate(failed, false)
  conversation.beginHydration()
  conversation.dispatch({
    type: 'stream',
    event: { name: 'response.recovered', payload: { subtaskId: 'turn', data: {} } },
  })
  conversation.hydrate(failed, true)
  expect(conversation.messages.at(-1)).toMatchObject({ status: 'completed', content: 'Answer' })
  expect(conversation.messages.at(-1)?.error).toBeUndefined()
})

it('keeps a real failure received during a read of an older successful snapshot', () => {
  const conversation = new MobileConversation(address)
  const old = snapshot([{ id: 'turn', status: 'completed', items: [text('after', 'Answer')] }])
  conversation.hydrate(old, false)
  conversation.beginHydration()
  conversation.dispatch({
    type: 'stream',
    event: {
      name: 'response.failed',
      payload: {
        subtaskId: 'turn',
        data: { error: { message: 'actual failure' }, type: 'provider_error' },
      },
    },
  })
  conversation.hydrate(old, true)
  expect(conversation.messages.at(-1)).toMatchObject({ status: 'failed', error: 'actual failure' })
})

it('replays guidance and new text in order while preserving optimistic attachment ownership', () => {
  const conversation = new MobileConversation(address)
  const old = snapshot([{ id: 'turn', status: 'inProgress', items: [text('before', 'Before')] }])
  conversation.hydrate(old, false)
  conversation.dispatch({ type: 'optimistic-user', id: 'guide', content: 'Continue', createdAt: 1 })
  conversation.beginHydration()
  conversation.dispatch({
    type: 'stream',
    event: {
      name: 'response.guidance.applied',
      payload: {
        subtaskId: 'turn',
        data: {
          guidanceId: 'guide',
          clientGuidanceId: 'guide',
          message: 'Continue',
          appliedAtMs: 2,
        },
      },
    },
  })
  delta(conversation, 'After')
  conversation.hydrate(old, true)
  expect(conversation.messages.map(message => message.content)).toEqual([
    'Before',
    'Continue',
    'After',
  ])
})

it('cannot revive superseded turns with late live events and resets ownership on a native thread change', () => {
  const conversation = new MobileConversation(address)
  conversation.hydrate(
    {
      ...snapshot(
        [{ id: 'turn', status: 'completed', items: [text('after', 'Old thread')] }],
        ['old']
      ),
      threadId: 'old-thread',
    },
    false
  )
  conversation.dispatch({
    type: 'stream',
    event: { name: 'response.created', payload: { subtaskId: 'old', data: {} } },
  })
  expect(conversation.turns.map(turn => turn.id)).toEqual(['turn'])
  conversation.hydrate(
    {
      ...snapshot([{ id: 'old', status: 'completed', items: [text('after', 'New thread')] }]),
      threadId: 'new-thread',
    },
    true
  )
  expect(conversation.messages.map(message => message.content)).toEqual(['New thread'])
})

it('retains an older page loaded while the latest page is in flight', () => {
  const conversation = new MobileConversation(address)
  const latest = snapshot([
    { id: 'turn', position: 2, status: 'inProgress', items: [text('after', 'New')] },
  ])
  conversation.hydrate(latest, false)
  conversation.beginHydration()
  conversation.prepend(
    snapshot([{ id: 'older', position: 1, status: 'completed', items: [text('first', 'Old')] }])
  )
  delta(conversation, ' answer')
  conversation.hydrate(latest, true)
  expect(conversation.messages.map(message => message.content)).toEqual(['Old', 'New answer'])
})

it('clears a prior provider failure when the native turn is cancelled', () => {
  const conversation = new MobileConversation(address)
  conversation.hydrate(
    snapshot([
      {
        id: 'turn',
        status: 'failed',
        error: 'old quota',
        errorType: 'quota_exceeded',
        items: [text('after', 'Partial')],
      },
    ]),
    false
  )
  conversation.dispatch({
    type: 'stream',
    event: {
      name: 'response.incomplete',
      payload: { subtaskId: 'turn', data: { type: 'cancelled', error: { message: 'cancelled' } } },
    },
  })
  expect(conversation.messages.at(-1)).toMatchObject({
    runtimeStatus: 'cancelled',
    stoppedNotice: true,
  })
  expect(conversation.messages.at(-1)?.error).toBeUndefined()
  expect(conversation.messages.at(-1)?.errorType).toBeUndefined()
})
