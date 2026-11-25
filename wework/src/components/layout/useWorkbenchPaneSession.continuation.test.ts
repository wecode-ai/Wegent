import {
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import { resetRuntimeConversationQueueControllersForTests } from '@/features/workbench/runtimeConversationQueueController'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'

import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { createScopedDraftStore } from '@/features/workbench/scopedDraftStore'

import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  pendingRequestUserInputPayload,
  pendingRequestUserInputResponses,
} from './requestUserInputOverlay'
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

vi.mock('@/features/workbench/useWorkbench', async () => {
  const { useState, useCallback } = await import('react')
  return {
    useWorkbenchPaneContext: () => {
      const [goalDraftActiveByScope, setGoals] = useState<Record<string, boolean>>({})
      const setGoalDraftActiveForScope = useCallback((scope: string, active: boolean) => {
        setGoals(current => ({ ...current, [scope]: active }))
      }, [])
      return {
        ...mocks.context,
        projectChat: {
          ...(mocks.context.projectChat as object),
          goalDraftActiveByScope,
          setGoalDraftActiveForScope,
        },
      }
    },
  }
})

const address = {
  deviceId: 'original-device',
  taskId: 'original-task',
  threadId: 'original-thread',
  workspacePath: '/workspace/original',
} satisfies RuntimeTaskAddress
const scopeKey = getRuntimeTaskChatScopeKey(address)
const draft = 'Unsent follow-up question'
const attachment = {
  id: 42,
  filename: 'unsent.txt',
  mime_type: 'text/plain',
  file_extension: '.txt',
  local_path: '/unsent.txt',
  status: 'ready' as const,
}
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
let lifecycleStore: RuntimeTaskLifecycleStore

test('skips async questions locally without sending, cancelling, or changing the active turn', async () => {
  const { result } = await renderSession()
  act(() => {
    reconcileRuntimeConversationSnapshot(address, [
      {
        id: 'skip-turn',
        status: 'streaming',
        items: ['skipped', 'retained'].map(itemId => ({
          id: itemId,
          type: 'block',
          block: {
            id: itemId,
            type: 'tool',
            toolName: 'request_user_input_async',
            status: 'done',
            createdAt: 1,
            renderPayload: {
              kind: 'request_user_input',
              delivery: 'async',
              itemId,
              questions: [{ id: 'question_1', question: `${itemId}?` }],
            },
          },
        })),
      },
    ])
    lifecycleStore.turnStarted(address, 'skip-turn')
  })
  const messages = result.current.messages
  const lifecycle = lifecycleStore.getTask(address)
  const revision = lifecycleStore.getTaskRevision(address)
  act(() => {
    result.current.skipRequestUserInput([
      { itemId: 'skipped', delivery: 'async' },
      { itemId: 'native-blocking' },
    ])
  })
  expect(result.current.answeredRequestUserInputIds.has('item:skipped')).toBe(true)
  expect(result.current.answeredRequestUserInputIds.has('item:native-blocking')).toBe(false)
  expect(
    pendingRequestUserInputPayload(
      result.current.messages,
      result.current.answeredRequestUserInputIds
    )?.itemId
  ).toBe('retained')
  expect(result.current.messages).toBe(messages)
  expect(lifecycleStore.getTask(address)).toStrictEqual(lifecycle)
  expect(lifecycleStore.getTaskRevision(address)).toBe(revision)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.guide).not.toHaveBeenCalled()
  expect(mocks.cancel).not.toHaveBeenCalled()
})

test.each(
  ['accepted', 'rejected', 'queued'].flatMap(outcome => [
    { outcome, interrupt: false },
    { outcome, interrupt: true },
  ])
)(
  'retains an unanswered question until delivery ($outcome, interrupt=$interrupt)',
  async ({ outcome, interrupt }) => {
    const restoreAttachment = vi.fn()
    Object.assign(mocks.context.projectChat as object, {
      addExistingAttachmentForScope: restoreAttachment,
    })
    const interruptSend = vi.fn()
    mocks.context.interruptAndSendRuntimePaneMessage = interruptSend
    const sendMethod = interrupt ? interruptSend : mocks.send
    const { result } = await renderSession()
    if (interrupt) act(() => lifecycleStore.turnStarted(address, 'question-turn'))
    act(() => {
      reconcileRuntimeConversationSnapshot(address, [
        {
          id: 'question-turn',
          status: 'done',
          items: [
            {
              id: 'question-item',
              type: 'block',
              block: {
                id: 'question-item',
                type: 'tool',
                toolName: 'request_user_input',
                status: 'done',
                createdAt: 1,
                renderPayload: {
                  kind: 'request_user_input',
                  delivery: 'async',
                  itemId: 'question-item',
                  questions: [{ id: 'audience', question: 'Who receives the report?' }],
                },
              },
            },
          ],
        },
      ])
    })
    let finish!: () => void
    sendMethod.mockImplementationOnce(
      (_request, options) =>
        new Promise<boolean>(resolve => {
          finish = () => {
            if (outcome === 'queued') options.onQueued?.({ queuePosition: 1 })
            resolve(outcome !== 'rejected')
          }
        })
    )
    let sending!: Promise<boolean>
    act(() => {
      sending = result.current.send('Continue with project members only', {
        interruptWhenBusy: interrupt,
      })
    })
    await waitFor(() => expect(sendMethod).toHaveBeenCalledOnce())
    expect(pendingRequestUserInputPayload(result.current.messages)?.itemId).toBe('question-item')
    expect(getRuntimeConversationQueuedMessages(address)).toContainEqual(
      expect.objectContaining({
        content: expect.stringContaining('Continue with project members only'),
        status: 'sending',
      })
    )
    expect(mocks.setInput).toHaveBeenCalledWith(scopeKey, '')
    await act(async () => {
      finish()
      await sending
    })
    expect(pendingRequestUserInputPayload(result.current.messages) === null).toBe(
      outcome === 'accepted'
    )
    expect(mocks.cancel).not.toHaveBeenCalled()
    if (outcome === 'rejected') expect(restoreAttachment).toHaveBeenCalledWith(scopeKey, attachment)
  }
)

test('retains a rejected queued send and its attachments while a question is pending', async () => {
  const { result } = await renderSession()
  const queued = {
    id: 'queued-question-retry',
    content: 'Keep this retryable',
    status: 'failed' as const,
    createdAt: new Date().toISOString(),
    attachments: [attachment],
  }
  act(() => {
    cacheRuntimeConversationQueuePaused(address, true)
    cacheRuntimeConversationQueuedMessages(address, [queued])
    reconcileRuntimeConversationSnapshot(address, [
      {
        id: 'question-turn',
        status: 'done',
        items: [
          {
            id: 'question-item',
            type: 'block',
            block: {
              id: 'question-item',
              type: 'tool',
              toolName: 'request_user_input',
              status: 'done',
              createdAt: 1,
              renderPayload: {
                kind: 'request_user_input',
                delivery: 'async',
                itemId: 'question-item',
                questions: [{ id: 'audience', question: 'Who receives the report?' }],
              },
            },
          },
        ],
      },
    ])
  })
  mocks.send.mockResolvedValueOnce(false)
  await act(async () => result.current.sendQueuedAsGuidance(queued.id))
  expect(mocks.send).toHaveBeenCalledOnce()
  expect(getRuntimeConversationQueuedMessages(address)).toEqual([
    expect.objectContaining({ ...queued, status: 'failed', error: '发送失败' }),
  ])
  expect(pendingRequestUserInputPayload(result.current.messages)?.itemId).toBe('question-item')
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.send.mockReset().mockResolvedValue(true)
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
  const draftStore = createScopedDraftStore()
  draftStore.write(scopeKey, draft)
  mocks.setInput.mockImplementation((scope: string, value: string) => {
    draftStore.write(scope, value)
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
      resolveRuntimeTaskModelSelection: vi.fn(() => ({
        selectionResolved: true,
        selectionReady: true,
        taskSelection: {
          modelName: 'original-model',
          modelType: 'runtime' as const,
          options: { reasoning: 'high' },
        },
        selectedModel: { name: 'original-model', type: 'runtime' as const },
        activeModel: { name: 'original-model', type: 'runtime' as const },
        selectedModelOptions: { reasoning: 'high' },
      })),
      setRuntimeTaskSelectedModel: vi.fn(),
      setRuntimeTaskSelectedModelAndOptions: vi.fn(),
      setRuntimeTaskSelectedModelOption: vi.fn(),
      models: [],
      draftStore,
      setInputForScope: mocks.setInput,
      replaceInputForScope: draftStore.replace,
      getInputRevisionForScope: (scope: string) => draftStore.read(scope).revision,
      captureAttachmentsForScope: (scope: string) => {
        const projectChat = mocks.context.projectChat as {
          attachmentStateByScope: Record<string, { attachments: Array<typeof attachment> }>
        }
        return [...(projectChat.attachmentStateByScope[scope]?.attachments ?? [])]
      },
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
  vi.useRealTimers()
  resetRuntimeConversationQueueControllersForTests()
  clearRuntimeConversationCacheForTests()
})

async function renderSession(currentRuntimeTask: RuntimeTaskAddress | null = address) {
  const hook = renderHook(
    ({ currentRuntimeTask }) =>
      useWorkbenchPaneSession({ currentRuntimeTask, debugSnapshotEnabled: false }),
    {
      initialProps: { currentRuntimeTask },
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(
          StrictMode,
          null,
          createElement(RuntimeTaskLifecycleProvider, { store: lifecycleStore, children })
        ),
    }
  )
  await waitFor(() => expect(hook.result.current.transcriptLoading).toBe(false))
  act(() => hook.result.current.addCodeComment(codeComment))
  return hook
}

function expectDraftPreserved(session: ReturnType<typeof useWorkbenchPaneSession>) {
  expect(session.getInput()).toBe(draft)
  expect(session.attachments).toEqual([attachment])
  expect(session.codeCommentContexts).toEqual([codeComment])
  expect(mocks.setInput).not.toHaveBeenCalled()
  expect(mocks.resetAttachments).not.toHaveBeenCalled()
}

describe('pane continuation without composer submission', () => {
  test('keeps a new turn interactive when the runtime reuses a previously answered request ID', async () => {
    const { result } = await renderSession()
    const formTurn = (id: string): RuntimeConversationTurn => ({
      id,
      status: 'streaming',
      items: [
        {
          id: 'request-user-input-0',
          type: 'block',
          block: {
            id: 'request-user-input-0',
            subtaskId: id,
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            createdAt: 1,
            renderPayload: {
              kind: 'request_user_input',
              requestId: 0,
              itemId: 'mcp_server_elicitation',
              interactionScope: id,
              questions: [{ id: 'action', question: 'Publish?' }],
            },
          },
        },
      ],
    })
    const previous = formTurn('previous-turn')
    const response = {
      requestId: 0,
      itemId: 'mcp_server_elicitation',
      interactionScope: previous.id!,
      answers: { action: { answers: ['Publish'] } },
    }
    act(() => reconcileRuntimeConversationSnapshot(address, [previous]))
    await act(async () => {
      expect(await result.current.sendRequestUserInputResponse(response)).toBe(true)
    })
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ requestUserInputResponse: response })
    )

    act(() => {
      reconcileRuntimeConversationSnapshot(address, [
        { ...previous, status: 'done' },
        formTurn('current-turn'),
      ])
    })
    await act(async () => {
      await result.current.sendRequestUserInputResponse(response)
    })

    const pending = pendingRequestUserInputPayload(
      result.current.messages,
      result.current.answeredRequestUserInputIds
    )
    expect(pending).toMatchObject({ requestId: 0, interactionScope: 'current-turn' })
    expect(pending).not.toHaveProperty('response')
  })
  test.each([
    { running: false, accepted: true },
    { running: false, accepted: false },
    { running: true, accepted: true },
    { running: true, accepted: false },
  ])(
    'updates async question waiting state only after an accepted reply (running=$running, accepted=$accepted)',
    async ({ running, accepted }) => {
      const { result } = await renderSession()
      mocks.send.mockImplementation(async (request, options) => {
        if (accepted)
          options?.onAccepted?.({
            accepted: true,
            taskId: address.taskId,
            ...(running
              ? { turnId: 'question-turn', guidanceId: request.clientUserMessageId }
              : {}),
          })
        return accepted
      })
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
      expect(mocks.send).toHaveBeenCalledWith(
        expect.objectContaining({
          address,
          message: 'Continue',
          requestUserInputResponse: {
            requestId: 'async-question',
            delivery: 'async',
            answers: { direction: { answers: ['Continue'] } },
          },
        }),
        expect.any(Object)
      )
      if (running && accepted) {
        expect(result.current.queuedMessages).toContainEqual(
          expect.objectContaining({
            content: 'Continue',
            status: 'sending',
            deliveryMode: 'guidance',
          })
        )
        expect(result.current.messages).toContainEqual(
          expect.objectContaining({
            role: 'user',
            content: 'Continue',
            runtimeGuidance: true,
          })
        )
      }
      if (!accepted) {
        expect(result.current.queuedMessages).toContainEqual(
          expect.objectContaining({
            status: 'failed',
            requestUserInputResponse: {
              requestId: 'async-question',
              delivery: 'async',
              answers: { direction: { answers: ['Continue'] } },
            },
          })
        )
      }
      expect(mocks.guide).not.toHaveBeenCalled()
      expectDraftPreserved(result.current)
    }
  )

  test.each([true])(
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
})

test.each([true, false])(
  'dismisses a question group with one cancellation and restores all IDs on failure (%s)',
  async accepted => {
    const { result } = await renderSession()
    mocks.cancel.mockResolvedValueOnce(accepted)
    await act(async () => {
      await result.current.ignoreRequestUserInput([
        { kind: 'request_user_input', delivery: 'async', itemId: 'first' },
        { kind: 'request_user_input', delivery: 'async', itemId: 'second' },
      ])
    })
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(result.current.answeredRequestUserInputIds.has('item:first')).toBe(accepted)
    expect(result.current.answeredRequestUserInputIds.has('item:second')).toBe(accepted)
  }
)

function completedGuidanceTurn(guidance: Partial<WorkbenchMessage> = {}): RuntimeConversationTurn {
  return {
    id: 'guidance-turn',
    status: 'done',
    items: [
      {
        id: 'guidance-message',
        type: 'user_message',
        message: {
          id: 'guidance-message',
          role: 'user',
          content: 'Original guidance',
          status: 'done',
          createdAt: '2026-11-25T00:00:00.000Z',
          runtimeGuidance: true,
          ...guidance,
        },
      },
      {
        id: 'assistant-after-guidance',
        type: 'assistant_text',
        content: 'Completed response',
        createdAt: '2026-11-25T00:00:01.000Z',
      },
    ],
  }
}

test('updates a guidance correction in place before transport and never appends a duplicate', async () => {
  const { result } = await renderSession()
  act(() => reconcileRuntimeConversationSnapshot(address, [completedGuidanceTurn()]))
  const guidance = await waitFor(() => {
    const message = result.current.messages.find(item => item.id === 'guidance-message')
    expect(message).toBeDefined()
    return message!
  })
  let finish!: (accepted: boolean) => void
  let usersAtTransport: WorkbenchMessage[] = []
  mocks.send.mockImplementationOnce((_request, options) => {
    usersAtTransport = getRuntimeConversationMessages(address).filter(
      message => message.role === 'user'
    )
    return new Promise<boolean>(resolve => {
      finish = accepted => {
        if (accepted) {
          options?.onAccepted?.({
            accepted: true,
            taskId: address.taskId,
            turnId: 'correction-turn',
          })
        }
        resolve(accepted)
      }
    })
  })

  let sending!: Promise<boolean>
  act(() => {
    sending = result.current.editLastUserMessage(guidance, 'Revised guidance')
  })
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
  expect(usersAtTransport).toHaveLength(1)
  expect(usersAtTransport[0]).toMatchObject({
    id: 'guidance-message',
    content: 'Revised guidance',
  })

  const pendingGuidance = getRuntimeConversationMessages(address).filter(
    message => message.role === 'user'
  )
  expect(pendingGuidance).toHaveLength(1)
  expect(pendingGuidance[0]).toMatchObject({
    id: 'guidance-message',
    content: 'Revised guidance',
    runtimeGuidance: true,
  })
  expect(mocks.send.mock.calls[0][0].message).toContain('Revised guidance')
  expect(mocks.send.mock.calls[0][0].clientUserMessageId).not.toBe('guidance-message')

  await act(async () => {
    finish(true)
    await sending
  })
  expect(
    getRuntimeConversationMessages(address).filter(message => message.role === 'user')
  ).toHaveLength(1)
  expect(result.current.messages.filter(message => message.role === 'user')).toHaveLength(1)
})

test('admits an attachment-only guidance correction before transport', async () => {
  const { result } = await renderSession()
  act(() =>
    reconcileRuntimeConversationSnapshot(address, [
      completedGuidanceTurn({ content: '', attachments: [attachment] }),
    ])
  )
  const guidance = await waitFor(() => {
    const message = result.current.messages.find(item => item.id === 'guidance-message')
    expect(message).toBeDefined()
    return message!
  })
  let finish!: () => void
  let usersAtTransport: WorkbenchMessage[] = []
  mocks.send.mockImplementationOnce(() => {
    usersAtTransport = getRuntimeConversationMessages(address).filter(
      message => message.role === 'user'
    )
    return new Promise<boolean>(resolve => {
      finish = () => resolve(true)
    })
  })

  let sending!: Promise<boolean>
  act(() => {
    sending = result.current.editLastUserMessage(guidance, '')
  })
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
  expect(usersAtTransport).toHaveLength(1)
  expect(usersAtTransport[0]).toMatchObject({ id: 'guidance-message', content: '' })
  const request = mocks.send.mock.calls[0][0]
  expect(request.message).not.toBe('')
  expect(request.attachments).toEqual([attachment])
  expect(
    getRuntimeConversationMessages(address).filter(message => message.role === 'user')
  ).toHaveLength(1)

  await act(async () => {
    finish()
    await sending
  })
  expect(
    getRuntimeConversationMessages(address).filter(message => message.role === 'user')
  ).toHaveLength(1)
})

test.each([true, false])(
  'settles the whole async group only after the runtime accepts its response (accepted=%s)',
  async accepted => {
    const { result } = await renderSession()
    mocks.send.mockResolvedValueOnce(accepted)
    act(() => {
      reconcileRuntimeConversationSnapshot(address, [
        {
          id: 'group-turn',
          status: 'streaming',
          items: ['first', 'second'].map(itemId => ({
            id: itemId,
            type: 'block',
            block: {
              id: itemId,
              type: 'tool',
              toolName: 'request_user_input',
              status: 'done',
              createdAt: 1,
              renderPayload: {
                kind: 'request_user_input',
                delivery: 'async',
                itemId,
                questions: [{ id: 'question_1', question: `${itemId}?` }],
              },
            },
          })),
        },
      ])
      lifecycleStore.turnStarted(address, 'group-turn')
    })
    const response = {
      itemId: 'first',
      answers: {
        question_1: { answers: ['One'] },
        '["item:second","question_1",0]': { answers: ['Two'] },
      },
    }
    const responses = pendingRequestUserInputResponses(response, result.current.messages)
    await act(async () => {
      expect(
        await result.current.sendRequestUserInputResponse(response, {
          requestUserInputResponses: responses,
        })
      ).toBe(accepted)
    })
    if (accepted) {
      expect(result.current.messages.flatMap(message => message.blocks ?? [])).toMatchObject([
        {
          renderPayload: {
            response: { itemId: 'first', answers: { question_1: { answers: ['One'] } } },
          },
        },
        {
          renderPayload: {
            response: { itemId: 'second', answers: { question_1: { answers: ['Two'] } } },
          },
        },
      ])
    }
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUserInputResponse: { ...response, delivery: 'async' },
      }),
      expect.objectContaining({ onAccepted: expect.any(Function) })
    )
    expect(mocks.guide).not.toHaveBeenCalled()
    expect(result.current.answeredRequestUserInputIds.has('item:first')).toBe(accepted)
    expect(result.current.answeredRequestUserInputIds.has('item:second')).toBe(accepted)
    expect(
      pendingRequestUserInputPayload(
        result.current.messages,
        result.current.answeredRequestUserInputIds
      ) === null
    ).toBe(accepted)
  }
)
