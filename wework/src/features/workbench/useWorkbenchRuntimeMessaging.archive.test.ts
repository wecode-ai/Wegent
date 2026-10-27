import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  RequestUserInputResponse,
  RuntimeSendResponse,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  clearRuntimeConversationCacheForTests,
  evictRuntimeConversation,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import { sendRuntimeQueuedMessage } from './runtimeQueuedMessageSender'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { useWorkbenchRuntimeMessaging } from './useWorkbenchRuntimeMessaging'
import { initialWorkbenchState } from './workbenchReducer'

const address = { deviceId: 'archive-test-device', taskId: 'archive-test-task' }
const queuedMessage = {
  id: 'archive-test-message',
  content: 'Test continuation',
  status: 'queued' as const,
  createdAt: '2026-10-19T00:00:00Z',
  modelId: 'test-model',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function fixture() {
  const store = new RuntimeTaskLifecycleStore('messaging-archive-test')
  store.syncRuntimeTask(address, {
    taskId: address.taskId,
    workspacePath: '/workspace/archive-test',
    title: 'Archive test',
    runtime: 'codex',
    running: false,
    continuable: true,
  })
  const send = vi.fn<(request: unknown) => Promise<RuntimeSendResponse>>()
  const list = vi.fn<() => Promise<RuntimeWorkListResponse>>()
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const dispatch = vi.fn()
  type Options = Parameters<typeof useWorkbenchRuntimeMessaging>[0]
  const options: Options = {
    state: { ...initialWorkbenchState, currentRuntimeTask: address },
    dispatch,
    executorClient: {
      runtime: { sendRuntimeMessage: send, listRuntimeWork: list },
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
  const archive = () => {
    evictRuntimeConversation(address)
    store.remove(address)
  }
  return { store, send, list, refresh, dispatch, messaging: result.current, archive }
}

function inputFixture() {
  const runtime = fixture()
  const response: RequestUserInputResponse = {
    requestId: 2,
    itemId: 'mcp_server_elicitation',
    answers: { audience: { answers: ['owner'] } },
  }
  const block = {
    id: 'request-user-input-2',
    subtaskId: 'elicitation-turn',
    type: 'tool' as const,
    toolName: 'request_user_input',
    status: 'pending' as const,
    createdAt: 2,
    renderPayload: {
      kind: 'request_user_input' as const,
      requestId: 2,
      itemId: 'mcp_server_elicitation',
      questions: [
        {
          id: 'audience',
          question: '访问范围',
          options: [{ label: '仅自己', value: 'owner' }],
        },
      ],
    },
  }
  reconcileRuntimeConversationSnapshot(address, [
    {
      id: 'elicitation-turn',
      status: 'streaming',
      items: [{ id: block.id, type: 'block', block }],
    },
  ])
  return { ...runtime, response, blockId: block.id }
}

describe('runtime message archival', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    vi.restoreAllMocks()
  })

  test.each(['accepted', 'queued', 'rejected', 'thrown'] as const)(
    'does not rebuild lifecycle or publish callbacks for a late %s RPC result',
    async outcome => {
      const { messaging, store, send, refresh, dispatch, archive } = fixture()
      const response = deferred<RuntimeSendResponse>()
      send.mockReturnValue(response.promise)
      const onError = vi.fn()
      const onQueued = vi.fn()
      const sending = messaging.sendRuntimePaneMessage(
        { address, message: 'Test continuation', modelId: 'test-model' },
        { onError, onQueued }
      )
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      archive()

      if (outcome === 'thrown') response.reject(new Error('Transport unavailable'))
      else
        response.resolve({
          accepted: outcome !== 'rejected',
          taskId: address.taskId,
          ...(outcome === 'queued' ? { status: 'queued', queuePosition: 1 } : {}),
        })

      await expect(sending).resolves.toBe(false)
      expect(store.getTask(address)).toBeNull()
      expect(getRuntimeConversationMessages(address)).toEqual([])
      expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
      expect(refresh).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      expect(onQueued).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    }
  )

  test('does not send when archival completes during continuation preparation', async () => {
    const { messaging, store, send, list, archive } = fixture()
    const work = deferred<RuntimeWorkListResponse>()
    list.mockReturnValue(work.promise)
    const sending = messaging.sendRuntimePaneMessage({ address, message: 'Test continuation' })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    archive()
    work.resolve({
      projects: [],
      chats: [
        {
          deviceId: address.deviceId,
          tasks: [
            {
              taskId: address.taskId,
              title: 'Archive test',
              modelSelection: { modelName: 'test-model', modelType: null, options: {} },
            },
          ],
        },
      ],
      totalTasks: 1,
    })

    await expect(sending).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(store.getTask(address)).toBeNull()
  })

  test('does not append an accepted message after archival during work-list refresh', async () => {
    const { messaging, store, send, refresh, archive } = fixture()
    const refreshed = deferred<void>()
    send.mockResolvedValue({ accepted: true, taskId: address.taskId })
    refresh.mockReturnValue(refreshed.promise)
    const sending = sendRuntimeQueuedMessage(address, queuedMessage, {
      lifecycleStore: store,
      sendRuntimePaneMessage: messaging.sendRuntimePaneMessage,
    })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    archive()
    refreshed.resolve()

    await expect(sending).resolves.toEqual({ accepted: false, queued: false })
    expect(store.getTask(address)).toBeNull()
    expect(getRuntimeConversationMessages(address)).toEqual([])
    expect(getRuntimeConversationQueuedMessages(address)).toEqual([])
  })

  test('still accepts an ordinary non-archived continuation', async () => {
    const { messaging, store, send, refresh } = fixture()
    send.mockResolvedValue({ accepted: true, taskId: address.taskId })

    await expect(
      sendRuntimeQueuedMessage(address, queuedMessage, {
        lifecycleStore: store,
        sendRuntimePaneMessage: messaging.sendRuntimePaneMessage,
      })
    ).resolves.toEqual({ accepted: true, queued: false })

    expect(
      getRuntimeConversationMessages(address)
        .filter(message => message.role === 'user')
        .map(message => message.id)
    ).toEqual([queuedMessage.id])
    expect(store.getTask(address)).not.toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test.each(['requestUserInputResponse', 'request_user_input_response'] as const)(
    'preserves an accepted %s before terminal history overtakes work-list refresh',
    async responseField => {
      const { messaging, send, refresh, response, blockId } = inputFixture()
      const refreshed = deferred<void>()
      send.mockResolvedValue({ accepted: true, taskId: address.taskId })
      refresh.mockReturnValue(refreshed.promise)
      const sending = messaging.sendRuntimePaneMessage({
        address,
        message: 'owner',
        modelId: 'test-model',
        [responseField]: response,
      })

      try {
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
        replaceRuntimeConversationSnapshot(address, [
          {
            id: 'elicitation-turn',
            status: 'done',
            items: [{ id: 'final', type: 'assistant_text', content: 'Completed' }],
          },
        ])

        expect(getRuntimeConversationTurns(address)[0].items).toContainEqual(
          expect.objectContaining({
            id: blockId,
            block: expect.objectContaining({
              status: 'done',
              renderPayload: expect.objectContaining({ response }),
            }),
          })
        )
      } finally {
        refreshed.resolve()
        await sending
      }
    }
  )

  test.each(['rejected', 'transport-failed'] as const)(
    'does not record an input answer when %s',
    async outcome => {
      const { messaging, send, refresh, response } = inputFixture()
      const before = getRuntimeConversationTurns(address)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (outcome === 'rejected') {
        send.mockResolvedValue({ accepted: false, error: 'Input is no longer pending' })
      } else send.mockRejectedValue(new Error('Transport unavailable'))

      await expect(
        messaging.sendRuntimePaneMessage({
          address,
          message: 'owner',
          modelId: 'test-model',
          requestUserInputResponse: response,
        })
      ).resolves.toBe(false)

      expect(getRuntimeConversationTurns(address)).toEqual(before)
      expect(refresh).not.toHaveBeenCalled()
      warning.mockRestore()
    }
  )

  test('does not restore an input answer accepted after its conversation was archived', async () => {
    const { messaging, send, refresh, response, archive } = inputFixture()
    const accepted = deferred<RuntimeSendResponse>()
    send.mockReturnValue(accepted.promise)
    const sending = messaging.sendRuntimePaneMessage({
      address,
      message: 'owner',
      modelId: 'test-model',
      requestUserInputResponse: response,
    })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    archive()
    accepted.resolve({ accepted: true, taskId: address.taskId })

    await expect(sending).resolves.toBe(false)
    expect(getRuntimeConversationTurns(address)).toEqual([])
    expect(refresh).not.toHaveBeenCalled()
  })
})
