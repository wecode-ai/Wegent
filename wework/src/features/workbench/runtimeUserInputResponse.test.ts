import { afterEach, expect, test } from 'vitest'
import type { RuntimeConversationTurn } from '@/types/workbench'
import {
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import { prepareRuntimeUserInputResponse } from './runtimeUserInputResponse'

const address = { deviceId: 'device-1', taskId: 'task-1' }
const response = { requestId: 0, answers: { audience: { answers: ['Owner'] } } }

function questionTurn(requestId = 0): RuntimeConversationTurn {
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
          status: 'pending',
          createdAt: 1,
          renderPayload: {
            kind: 'request_user_input',
            requestId,
            questions: [{ id: 'audience', question: 'Audience?' }],
          },
        },
      },
    ],
  }
}

afterEach(clearRuntimeConversationCacheForTests)

test('retains a zero-id answer across terminal history without mutating the pending question', () => {
  const pending = questionTurn()
  const user: RuntimeConversationTurn['items'][number] = {
    id: 'user',
    type: 'user_message',
    message: { id: 'user', role: 'user', content: 'Start', status: 'done' },
  }
  const cancelledUrl: RuntimeConversationTurn['items'][number] = {
    id: 'url-authorization',
    type: 'block',
    block: {
      id: 'url-authorization',
      type: 'tool',
      toolName: 'request_user_input',
      status: 'done',
      createdAt: 0,
      renderPayload: {
        kind: 'request_user_input',
        interactionKind: 'mcp_url',
        requestId: 1,
        response: { requestId: 1, answers: { __mcp_url: { answers: ['cancel'] } } },
      },
    },
  }
  pending.items.unshift(user, cancelledUrl)
  reconcileRuntimeConversationSnapshot(address, [pending])
  const commitResponse = prepareRuntimeUserInputResponse(address, response)
  expect(getRuntimeConversationTurns(address)[0]).toEqual(pending)
  replaceRuntimeConversationSnapshot(address, [{ id: 'turn-1', status: 'done', items: [user] }])

  commitResponse()
  commitResponse()

  expect(getRuntimeConversationTurns(address)).toMatchObject([
    {
      status: 'done',
      items: [
        user,
        cancelledUrl,
        { block: { status: 'done', renderPayload: { requestId: 0, response } } },
      ],
    },
  ])
  expect(pending.items[2]).toMatchObject({ block: { status: 'pending' } })
})

test('does not apply an old answer to a different request that reuses the block id', () => {
  reconcileRuntimeConversationSnapshot(address, [questionTurn()])
  const commitResponse = prepareRuntimeUserInputResponse(address, response)
  reconcileRuntimeConversationSnapshot(address, [questionTurn(1)])

  commitResponse()

  expect(getRuntimeConversationTurns(address)).toEqual([questionTurn(1)])
})

test('keeps an authoritative response when the acknowledgement arrives late', () => {
  reconcileRuntimeConversationSnapshot(address, [questionTurn()])
  const commitResponse = prepareRuntimeUserInputResponse(address, response)
  const authoritative = { ...response, answers: { audience: { answers: ['Everyone'] } } }
  const answered = questionTurn()
  const item = answered.items[0]
  if (item.type !== 'block' || item.block.type !== 'tool') throw new Error('Missing question')
  item.block.status = 'done'
  item.block.renderPayload = { ...(item.block.renderPayload as object), response: authoritative }
  reconcileRuntimeConversationSnapshot(address, [answered])

  commitResponse()

  expect(getRuntimeConversationTurns(address)).toEqual([answered])
})
