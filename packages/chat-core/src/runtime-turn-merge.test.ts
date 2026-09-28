import { describe, expect, it } from 'vitest'
import type { RuntimeConversationTurn } from './runtime-conversation'
import type { RequestUserInputResponse } from './runtime'
import { mergeRuntimeConversationTurns } from './runtime-conversation-turns'

function question(requestId: string, response?: RequestUserInputResponse): RuntimeConversationTurn {
  return {
    id: 'turn-1',
    status: 'streaming',
    items: [
      {
        id: 'question',
        type: 'block',
        block: {
          id: 'question',
          type: 'tool',
          toolName: 'request_user_input',
          status: response ? 'done' : 'pending',
          createdAt: 1,
          renderPayload: {
            kind: 'request_user_input',
            requestId,
            questions: [{ id: 'scope', question: 'Scope?' }],
            response,
          },
        },
      },
    ],
  }
}
const accepted = { requestId: 'request-1', answers: { scope: { answers: ['This project'] } } }
function merged(local: RuntimeConversationTurn, snapshot: RuntimeConversationTurn) {
  const item = mergeRuntimeConversationTurns([local], [snapshot])[0].items[0]
  if (item.type !== 'block') throw new Error('Question block missing')
  return item.block
}

describe('runtime question history reconciliation for both hosts', () => {
  it('retains an accepted answer when refreshing a still-streaming turn', () => {
    expect(merged(question('request-1', accepted), question('request-1'))).toMatchObject({
      status: 'done',
      renderPayload: { response: accepted },
    })
  })
  it('keeps the authoritative response when history already records an answer', () => {
    const authoritative = { ...accepted, answers: { scope: { answers: ['All projects'] } } }
    expect(
      merged(question('request-1', accepted), question('request-1', authoritative))
    ).toMatchObject({
      renderPayload: { response: authoritative },
    })
  })
  it('does not carry an answer into a different question reusing the same item', () => {
    expect(merged(question('request-1', accepted), question('request-2'))).toMatchObject({
      status: 'pending',
      renderPayload: { requestId: 'request-2', response: undefined },
    })
  })
  it('does not turn a failed question into a successful answer', () => {
    const snapshot = question('request-1')
    const item = snapshot.items[0]
    if (item.type === 'block') item.block.status = 'error'
    expect(merged(question('request-1', accepted), snapshot)).toMatchObject({ status: 'error' })
  })
})
