import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import {
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuePaused,
  getRuntimeConversationMessages,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import type { RuntimeConversationTurn } from '@/types/workbench'
import {
  getRuntimeConversationQueueController,
  resetRuntimeConversationQueueControllersForTests,
} from '@/features/workbench/runtimeConversationQueueController'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { useWorkbenchPaneSession } from './useWorkbenchPaneSession'

const mocks = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  send: vi.fn(),
  guide: vi.fn(),
  cancel: vi.fn(),
  setInput: vi.fn(),
  resetAttachments: vi.fn(),
  setError: vi.fn(),
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => mocks.context,
}))

const address = {
  deviceId: 'original-device',
  taskId: 'original-task',
  threadId: 'original-thread',
  workspacePath: '/workspace/original',
} satisfies RuntimeTaskAddress
const scopeKey = getRuntimeTaskChatScopeKey(address)
const draft = 'Unsent follow-up question'
const attachment = { id: 42, name: 'unsent.txt', url: '/unsent.txt', mimeType: 'text/plain' }
const codeComment = {
  id: 'draft-comment',
  filePath: '/workspace/original/app.ts',
  fileName: 'app.ts',
  startLine: 1,
  endLine: 1,
  selectedText: 'const value = 1',
  comment: 'Unsent review feedback',
  createdAt: '2026-10-15T00:00:00Z',
}
const continuation = 'Authorization is complete. Continue from the blocked operation.'
let lifecycleStore: RuntimeTaskLifecycleStore

beforeEach(() => {
  vi.clearAllMocks()
  mocks.send.mockResolvedValue(true)
  mocks.guide.mockResolvedValue({ sent: true, turnId: 'answer-turn' })
  mocks.cancel.mockResolvedValue(true)
  lifecycleStore = new RuntimeTaskLifecycleStore('pane-continuation-test')
  lifecycleStore.syncRuntimeTask(address, {
    taskId: address.taskId,
    workspacePath: address.workspacePath,
    title: 'Continuation task',
    runtime: 'codex',
    running: false,
    continuable: true,
  })
  mocks.context = {
    state: {
      currentRuntimeTask: { ...address, taskId: 'another-selected-task' },
      runtimeWork: null,
    },
    projectChat: {
      scopeKey: 'blank-chat',
      inputByScope: { [scopeKey]: draft },
      attachmentStateByScope: {
        [scopeKey]: { attachments: [attachment], uploadingFiles: new Map(), errors: new Map() },
      },
      selectedModel: { name: 'original-model', type: 'runtime' },
      selectedModelOptions: { reasoning: 'high' },
      models: [],
      setInputForScope: mocks.setInput,
      resetAttachmentsForScope: mocks.resetAttachments,
      setComposerErrorForScope: mocks.setError,
    },
    sendRuntimePaneMessage: mocks.send,
    sendRuntimePaneGuidance: mocks.guide,
    cancelRuntimePaneTask: mocks.cancel,
    getRuntimeGoal: vi.fn().mockResolvedValue({ accepted: false }),
    loadRuntimeTranscriptForPane: vi.fn().mockResolvedValue({ messages: [], turns: [] }),
    refreshWorkLists: vi.fn().mockResolvedValue(undefined),
  }
})

afterEach(() => {
  cleanup()
  resetRuntimeConversationQueueControllersForTests()
  clearRuntimeConversationCacheForTests()
})

async function renderSession(currentRuntimeTask: RuntimeTaskAddress | null = address) {
  const hook = renderHook(
    () => useWorkbenchPaneSession({ currentRuntimeTask, debugSnapshotEnabled: false }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(RuntimeTaskLifecycleProvider, { store: lifecycleStore, children }),
    }
  )
  await waitFor(() => expect(hook.result.current.transcriptLoading).toBe(false))
  act(() => hook.result.current.addCodeComment(codeComment))
  return hook
}

function expectDraftPreserved(session: ReturnType<typeof useWorkbenchPaneSession>) {
  expect(session.input).toBe(draft)
  expect(session.attachments).toEqual([attachment])
  expect(session.codeCommentContexts).toEqual([codeComment])
  expect(mocks.setInput).not.toHaveBeenCalled()
  expect(mocks.resetAttachments).not.toHaveBeenCalled()
}

describe('pane continuation without composer submission', () => {
  test.each([
    { running: false, accepted: true },
    { running: false, accepted: false },
    { running: true, accepted: true },
    { running: true, accepted: false },
  ])(
    'updates async question waiting state only after an accepted reply (running=$running, accepted=$accepted)',
    async ({ running, accepted }) => {
      const { result } = await renderSession()
      mocks.send.mockResolvedValue(accepted)
      mocks.guide.mockResolvedValue({ sent: accepted, turnId: 'answer-turn' })
      act(() => {
        reconcileRuntimeConversationSnapshot(address, [
          {
            id: 'question-turn',
            status: running ? 'streaming' : 'done',
            items: [
              {
                id: 'async-question',
                type: 'block',
                block: {
                  id: 'async-question',
                  type: 'tool',
                  toolName: 'request_user_input',
                  status: 'done',
                  createdAt: 1,
                  renderPayload: {
                    kind: 'request_user_input',
                    requestId: 'async-question',
                    delivery: 'async',
                    questions: [{ id: 'direction', question: 'Which direction?' }],
                  },
                },
              },
            ],
          },
        ])
        if (running) lifecycleStore.turnStarted(address, 'question-turn')
        lifecycleStore.userInputRequested(address, 'async')
      })
      expect(lifecycleStore.getTask(address)?.derived.shouldShowSidebarWaiting).toBe(true)

      await act(async () => {
        expect(
          await result.current.sendRequestUserInputResponse({
            requestId: 'async-question',
            answers: { direction: { answers: ['Continue'] } },
          })
        ).toBe(accepted)
      })

      expect(lifecycleStore.getTask(address)?.derived.shouldShowSidebarWaiting).toBe(!accepted)
      const sender = running ? mocks.guide : mocks.send
      expect(sender).toHaveBeenCalledWith(
        expect.objectContaining({ address, message: 'Continue' }),
        ...(running ? [] : [expect.any(Object)])
      )
      expectDraftPreserved(result.current)
    }
  )

  test.each([true, false])(
    'retains a form while terminal history arrives before its response acknowledgment (accepted=%s)',
    async accepted => {
      const { result } = await renderSession()
      const response = { requestId: 2, answers: { audience: { answers: ['owner'] } } }
      const terminal: RuntimeConversationTurn = {
        id: 'elicitation-turn',
        status: 'done',
        items: [{ id: 'final', type: 'assistant_text', content: 'Complete' }],
      }
      act(() => {
        reconcileRuntimeConversationSnapshot(address, [
          {
            ...terminal,
            status: 'streaming',
            items: [
              {
                id: 'request-user-input-2',
                type: 'block',
                block: {
                  id: 'request-user-input-2',
                  type: 'tool',
                  toolName: 'request_user_input',
                  status: 'pending',
                  createdAt: 1,
                  renderPayload: {
                    kind: 'request_user_input',
                    requestId: 2,
                    questions: [{ id: 'audience', question: 'Access audience?' }],
                  },
                },
              },
            ],
          },
        ])
      })
      mocks.send.mockImplementation(async () => {
        replaceRuntimeConversationSnapshot(address, [terminal])
        return accepted
      })

      await act(async () => {
        expect(await result.current.sendRequestUserInputResponse(response)).toBe(accepted)
      })

      const form = getRuntimeConversationMessages(address)
        .flatMap(message => message.blocks ?? [])
        .find(block => block.id === 'request-user-input-2')
      expect(form).toBeDefined()
      expect(form?.renderPayload).toMatchObject({
        requestId: 2,
        ...(accepted ? { response } : {}),
      })
      if (!accepted) expect(form?.renderPayload).not.toHaveProperty('response')
      act(() => replaceRuntimeConversationSnapshot(address, [terminal]))
      expect(
        getRuntimeConversationMessages(address)
          .flatMap(message => message.blocks ?? [])
          .some(block => block.id === 'request-user-input-2')
      ).toBe(accepted)
    }
  )

  test('continues the bound task with its model and leaves an unsent draft intact', async () => {
    const { result } = await renderSession()

    await act(async () => expect(await result.current.sendContinuation(continuation)).toBe(true))

    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        address,
        message: continuation,
        modelId: 'original-model',
        modelOptions: expect.objectContaining({ reasoning: 'high' }),
      }),
      expect.any(Object)
    )
    const [request] = mocks.send.mock.calls[0]
    expect(request).not.toHaveProperty('attachmentIds')
    expect(request).not.toHaveProperty('attachments')
    expect(request.message).not.toContain(codeComment.comment)
    expectDraftPreserved(result.current)
  })

  test('retains a continuation queued by the original executor without consuming the draft', async () => {
    mocks.send.mockImplementation(async (_request, options) => {
      options.onQueued({ queuePosition: 2 })
      return true
    })
    const { result } = await renderSession()

    await act(async () => expect(await result.current.sendContinuation(continuation)).toBe(true))

    expect(result.current.queuedMessages).toMatchObject([
      { content: continuation, runtimeQueued: true, runtimeQueuePosition: 2 },
    ])
    expect(result.current.queuedMessages[0]).not.toHaveProperty('attachments')
    expectDraftPreserved(result.current)
  })

  test('retries a busy continuation on lifecycle changes after the pane unmounts', async () => {
    mocks.send.mockImplementationOnce(async (_request, options) => {
      options.onError('runtime task is already running')
      return false
    })
    const { result, rerender, unmount } = await renderSession()

    await act(async () => expect(await result.current.sendContinuation(continuation)).toBe(true))
    rerender()

    expect(result.current.queuedMessages).toMatchObject([
      { content: continuation, status: 'queued' },
    ])
    expect(mocks.send).toHaveBeenCalledOnce()
    expectDraftPreserved(result.current)

    const queuedMessage = result.current.queuedMessages[0]
    unmount()
    await act(async () => lifecycleStore.executorStarted(address))
    expect(mocks.send).toHaveBeenCalledOnce()

    await act(async () => lifecycleStore.executorSettled(address))

    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address,
        message: continuation,
        clientUserMessageId: queuedMessage.id,
      }),
      expect.any(Object)
    )
  })

  test.each(['rejected', 'transport'])(
    'reports a %s send failure without changing the draft',
    async kind => {
      if (kind === 'transport') mocks.send.mockRejectedValue(new Error('executor offline'))
      else {
        mocks.send.mockImplementation(async (_request, options) => {
          options.onError('executor offline')
          return false
        })
      }
      const { result } = await renderSession()

      await act(async () => expect(await result.current.sendContinuation(continuation)).toBe(false))

      expect(mocks.setError).toHaveBeenLastCalledWith(scopeKey, 'executor offline')
      expect(result.current.queuedMessages).toEqual([])
      expect(result.current.messages).toEqual([])
      expectDraftPreserved(result.current)
    }
  )

  test('does not create a task for an unbound conversation', async () => {
    const { result } = await renderSession(null)

    await act(async () => expect(await result.current.sendContinuation(continuation)).toBe(false))

    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('composer cancellation rollback', () => {
  test.each([
    { pendingResume: false, outcome: 'rejected' },
    { pendingResume: true, outcome: 'rejected' },
    { pendingResume: true, outcome: 'thrown' },
    { pendingResume: true, outcome: 'accepted' },
  ] as const)(
    'preserves queue intent after $outcome cancellation (pendingResume=$pendingResume)',
    async ({ pendingResume, outcome }) => {
      const queuedMessage = {
        id: 'preserved-follow-up',
        content: 'Continue the queued work',
        status: 'queued' as const,
        createdAt: '2026-10-19T00:00:00Z',
      }
      cacheRuntimeConversationQueuePaused(address, true)
      cacheRuntimeConversationQueuedMessages(address, [queuedMessage])
      if (pendingResume) {
        getRuntimeConversationQueueController(address).resumeAfterTurn(
          lifecycleStore.getTask(address)
        )
      }
      lifecycleStore.turnStarted(address, 'manual-turn')
      const { result, unmount } = await renderSession()
      if (outcome === 'thrown') {
        mocks.cancel.mockRejectedValue(new Error('executor offline'))
      } else {
        mocks.cancel.mockResolvedValue(outcome === 'accepted')
      }

      await act(async () => {
        const stopping = result.current.pauseCurrentResponse()
        if (outcome === 'thrown') await expect(stopping).rejects.toThrow('executor offline')
        else await stopping
      })

      expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(address)
      expect(result.current.queuedMessagesPaused).toBe(true)
      expect(getRuntimeConversationQueuedMessages(address)).toEqual([queuedMessage])
      expect(mocks.send).not.toHaveBeenCalled()

      unmount()
      await act(async () => {
        lifecycleStore.turnSettled(
          address,
          'manual-turn',
          outcome === 'accepted' ? 'cancelled' : 'succeeded'
        )
        lifecycleStore.executorSettled(address)
      })

      if (pendingResume && outcome !== 'accepted') {
        await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
        expect(mocks.send).toHaveBeenCalledWith(
          expect.objectContaining({ address, clientUserMessageId: queuedMessage.id }),
          expect.any(Object)
        )
        expect(getRuntimeConversationQueuePaused(address)).toBe(false)
      } else {
        expect(getRuntimeConversationQueuePaused(address)).toBe(true)
        expect(getRuntimeConversationQueuedMessages(address)).toEqual([queuedMessage])
        expect(mocks.send).not.toHaveBeenCalled()
      }
    }
  )
})

describe('accepted async question replies', () => {
  test.each([true, false])(
    'clears global waiting only after reply acceptance (%s)',
    async accepted => {
      const { result } = await renderSession()
      act(() => lifecycleStore.userInputRequested(address, 'async'))
      mocks.send.mockResolvedValue(accepted)
      await act(async () => {
        expect(
          await result.current.sendRequestUserInputResponse(
            { requestId: 'async-question', answers: { direction: { answers: ['Complete'] } } },
            { appendUserMessage: true }
          )
        ).toBe(accepted)
      })
      expect(lifecycleStore.getTask(address)?.derived.shouldShowSidebarWaiting).toBe(!accepted)
    }
  )
})
