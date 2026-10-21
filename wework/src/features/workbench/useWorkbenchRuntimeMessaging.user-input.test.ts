import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RequestUserInputResponse, RuntimeSendResponse } from '@/types/api'
import type { RuntimeConversationTurn } from '@/types/workbench'
import {
  clearRuntimeConversationCacheForTests,
  evictRuntimeConversation,
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { useWorkbenchRuntimeMessaging } from './useWorkbenchRuntimeMessaging'
import { initialWorkbenchState } from './workbenchReducer'

const address = { deviceId: 'input-test-device', taskId: 'input-test-task' }
const answer: RequestUserInputResponse = {
  requestId: 2,
  answers: { audience: { answers: ['仅自己'] } },
}
const toolItem = {
  id: 'mcp-call',
  type: 'block' as const,
  block: {
    id: 'mcp-call',
    type: 'tool' as const,
    toolName: 'confirm_inner_site_access',
    status: 'done' as const,
    createdAt: 1,
  },
}

function questionItem(requestId = 2): RuntimeConversationTurn['items'][number] {
  return {
    id: 'request-user-input-2',
    type: 'block',
    block: {
      id: 'request-user-input-2',
      type: 'tool',
      toolName: 'request_user_input',
      status: 'pending',
      createdAt: 3,
      renderPayload: {
        kind: 'request_user_input',
        requestId,
        questions: [{ id: 'audience', question: '访问范围', options: [{ label: '仅自己' }] }],
      },
    },
  }
}

function terminalTurn(
  items: RuntimeConversationTurn['items'] = [toolItem]
): RuntimeConversationTurn {
  return {
    id: 'turn-1',
    status: 'done',
    items: [...items, { id: 'final-text', type: 'assistant_text', content: '完成', createdAt: 4 }],
  }
}

function fixture() {
  const store = new RuntimeTaskLifecycleStore('messaging-user-input-test')
  const send = vi.fn<(request: unknown) => Promise<RuntimeSendResponse>>()
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const urlItem: RuntimeConversationTurn['items'][number] = {
    id: 'request-user-input-1',
    type: 'block',
    block: {
      id: 'request-user-input-1',
      type: 'tool',
      toolName: 'request_user_input',
      status: 'done',
      createdAt: 2,
      renderPayload: {
        kind: 'request_user_input',
        interactionKind: 'mcp_url',
        requestId: 1,
        questions: [],
        response: { requestId: 1, answers: { __mcp_url: { answers: ['cancel'] } } },
      },
    },
  }
  reconcileRuntimeConversationSnapshot(address, [
    {
      id: 'turn-1',
      status: 'streaming',
      items: [
        toolItem,
        urlItem,
        questionItem(),
        { id: 'stale-text', type: 'assistant_text', content: 'still running', createdAt: 3 },
      ],
    },
  ])
  type Options = Parameters<typeof useWorkbenchRuntimeMessaging>[0]
  const options: Options = {
    state: { ...initialWorkbenchState, currentRuntimeTask: address },
    dispatch: vi.fn(),
    executorClient: {
      runtime: { sendRuntimeMessage: send },
    } as unknown as Options['executorClient'],
    services: { taskApi: {} } as unknown as Options['services'],
    runtimeTasks: {} as Options['runtimeTasks'],
    lifecycleStore: store,
    projectExecutionMode: 'default',
    projectWorktreeBranch: null,
    isOptionsLocked: false,
    attachmentSelection: { attachments: [], resetAttachments: vi.fn() },
    modelSelection: { models: [], selectedModel: null, selectedModelOptions: {} },
    skillSelection: { selectedSkills: [] },
    refreshWorkLists: refresh,
  }
  const { result } = renderHook(() => useWorkbenchRuntimeMessaging(options))
  const submit = () =>
    result.current.sendRuntimePaneMessage(
      { address, message: '仅自己', requestUserInputResponse: answer },
      { onError: vi.fn() }
    )
  return { send, refresh, submit }
}

function answeredForm() {
  return expect.objectContaining({
    id: 'request-user-input-2',
    type: 'block',
    block: expect.objectContaining({
      status: 'done',
      renderPayload: expect.objectContaining({
        requestId: 2,
        response: answer,
        questions: [expect.objectContaining({ id: 'audience', question: '访问范围' })],
      }),
    }),
  })
}

describe('runtime user input acknowledgement', () => {
  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    vi.restoreAllMocks()
  })

  test('retains an accepted form when terminal history arrives before the RPC acknowledgement', async () => {
    const { send, refresh, submit } = fixture()
    let itemsAtRefresh: RuntimeConversationTurn['items'] = []
    send.mockImplementation(async () => {
      replaceRuntimeConversationSnapshot(address, [terminalTurn()])
      return { accepted: true }
    })
    refresh.mockImplementation(async () => {
      itemsAtRefresh = getRuntimeConversationTurns(address)[0].items
      replaceRuntimeConversationSnapshot(address, [terminalTurn()])
    })

    await expect(submit()).resolves.toBe(true)

    expect(itemsAtRefresh).toContainEqual(answeredForm())
    const turn = getRuntimeConversationTurns(address)[0]
    expect(turn.status).toBe('done')
    expect(turn.items.map(item => item.id)).toEqual([
      'mcp-call',
      'final-text',
      'request-user-input-1',
      'request-user-input-2',
    ])
    expect(turn.items).toContainEqual(answeredForm())
    expect(turn.items).toContainEqual(
      expect.objectContaining({
        id: 'request-user-input-1',
        block: expect.objectContaining({
          renderPayload: expect.objectContaining({ interactionKind: 'mcp_url', requestId: 1 }),
        }),
      })
    )
  })

  test.each(['rejected', 'thrown'] as const)(
    'does not record an answer for a %s RPC',
    async outcome => {
      const { send, refresh, submit } = fixture()
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (outcome === 'rejected')
        send.mockResolvedValue({ accepted: false, error: 'Input rejected' })
      else send.mockRejectedValue(new Error('Transport unavailable'))

      await expect(submit()).resolves.toBe(false)

      expect(getRuntimeConversationTurns(address)[0].items).toContainEqual(questionItem())
      expect(refresh).not.toHaveBeenCalled()
      warning.mockRestore()
    }
  )

  test.each(['evicted', 'replaced'] as const)(
    'does not restore an input into a %s turn',
    async state => {
      const { send, submit } = fixture()
      send.mockImplementation(async () => {
        if (state === 'evicted') evictRuntimeConversation(address)
        else
          replaceRuntimeConversationSnapshot(address, [{ ...terminalTurn(), id: 'different-turn' }])
        return { accepted: true }
      })

      await expect(submit()).resolves.toBe(state !== 'evicted')

      expect(getRuntimeConversationTurns(address).flatMap(turn => turn.items)).not.toContainEqual(
        answeredForm()
      )
    }
  )

  test('does not answer a different request reusing the same block identity', async () => {
    const { send, submit } = fixture()
    send.mockImplementation(async () => {
      replaceRuntimeConversationSnapshot(address, [terminalTurn([toolItem, questionItem(3)])])
      return { accepted: true }
    })

    await expect(submit()).resolves.toBe(true)

    expect(getRuntimeConversationTurns(address)[0].items).toContainEqual(questionItem(3))
    expect(getRuntimeConversationTurns(address)[0].items).not.toContainEqual(answeredForm())
  })
})
