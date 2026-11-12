import { useConversationFind } from '@/components/chat/useConversationFind'
import {
  applyRuntimeConversationAction,
  archiveRuntimeConversation,
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuePaused,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
  unmarkRuntimeConversationArchived,
} from '@/features/workbench/runtimeConversationCache'
import {
  getRuntimeConversationQueueController,
  resetRuntimeConversationQueueControllersForTests,
} from '@/features/workbench/runtimeConversationQueueController'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { useScopedDraftInput } from '@/features/workbench/useScopedDraftInput'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { getPlatform } from '@/lib/platform'
import { createConversationMentionReference } from '@/lib/conversation-mentions'
import type { RuntimeGoal, RuntimeTaskAddress } from '@/types/api'
import type {
  RuntimeConversationTurn,
  RuntimePaneTranscript,
  RuntimeTranscriptLoader,
  WorkbenchMessage,
} from '@/types/workbench'
import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react'
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

test.each([false, true])(
  'keeps normal optimistic sending after a question was dismissed (interrupt=%s)',
  async interrupt => {
    Object.assign(mocks.context.projectChat as object, {
      addExistingAttachmentForScope: vi.fn(),
    })
    const interruptSend = vi.fn()
    mocks.context.interruptAndSendRuntimePaneMessage = interruptSend
    const sendMethod = interrupt ? interruptSend : mocks.send
    const { result } = await renderSession()
    const payload = {
      kind: 'request_user_input' as const,
      delivery: 'async' as const,
      itemId: 'dismissed-question',
      questions: [{ id: 'audience', question: 'Who receives the report?' }],
    }
    act(() => {
      reconcileRuntimeConversationSnapshot(address, [
        {
          id: 'question-turn',
          status: 'done',
          items: [
            {
              id: payload.itemId,
              type: 'block',
              block: {
                id: payload.itemId,
                type: 'tool',
                toolName: 'request_user_input',
                status: 'done',
                createdAt: 1,
                renderPayload: payload,
              },
            },
          ],
        },
      ])
    })
    await act(async () => result.current.ignoreRequestUserInput(payload))
    if (interrupt) act(() => lifecycleStore.turnStarted(address, 'follow-up-turn'))
    let finish!: (accepted: boolean) => void
    sendMethod.mockImplementationOnce(() => new Promise<boolean>(resolve => (finish = resolve)))
    let sending!: Promise<boolean>
    act(() => {
      sending = result.current.send('A new follow-up', { interruptWhenBusy: interrupt })
    })
    await waitFor(() => expect(sendMethod).toHaveBeenCalledOnce())
    expect(getRuntimeConversationMessages(address)).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'A new follow-up' })
    )
    await act(async () => {
      finish(false)
      expect(await sending).toBe(false)
    })
    expect(getRuntimeConversationMessages(address)).not.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'A new follow-up' })
    )
    expect(result.current.answeredRequestUserInputIds.has('item:dismissed-question')).toBe(true)
  }
)

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
  const sharedRevisions = new Map<string, number>()
  mocks.setInput.mockImplementation((scope: string, value: string) => {
    const context = mocks.context.projectChat as { inputByScope: Record<string, string> }
    context.inputByScope = { ...context.inputByScope, [scope]: value }
    sharedRevisions.set(scope, (sharedRevisions.get(scope) ?? 0) + 1)
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
      getInputRevisionForScope: (scope: string) => sharedRevisions.get(scope) ?? 0,
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
  expect(session.input).toBe(draft)
  expect(session.attachments).toEqual([attachment])
  expect(session.codeCommentContexts).toEqual([codeComment])
  expect(mocks.setInput).not.toHaveBeenCalled()
  expect(mocks.resetAttachments).not.toHaveBeenCalled()
}

describe('pane transcript reload ownership', () => {
  const restoredTranscript: RuntimePaneTranscript = {
    messages: [],
    turns: [
      {
        id: 'restored-turn',
        status: 'done',
        items: [
          {
            id: 'restored-user',
            type: 'user_message',
            message: {
              id: 'restored-user',
              role: 'user',
              content: 'Original archived prompt',
              status: 'done',
              createdAt: '2026-10-15T00:00:00Z',
            },
          },
        ],
      },
    ],
  }

  const readRestoredTranscript: RuntimeTranscriptLoader = async owner => {
    replaceRuntimeConversationSnapshot(owner, restoredTranscript.turns)
    return restoredTranscript
  }

  test.each(['failed', 'loaded'] as const)(
    'invalidates an archived owner %s read and reads its restored same-address history',
    async previousRead => {
      const load = vi.fn<RuntimeTranscriptLoader>()
      if (previousRead === 'failed') load.mockRejectedValue(new Error('thread is archived'))
      else load.mockImplementation(readRestoredTranscript)
      mocks.context.loadRuntimeTranscriptForPane = load
      const { result, rerender } = await renderSession()
      expect(result.current.transcriptError).toBe(
        previousRead === 'failed' ? 'thread is archived' : null
      )

      act(() => {
        archiveRuntimeConversation(address)
        rerender({ currentRuntimeTask: null })
      })
      expect(result.current.transcriptError).toBeNull()
      const archivedReadCount = load.mock.calls.length
      load.mockImplementation(readRestoredTranscript)
      act(() => {
        unmarkRuntimeConversationArchived(address)
        rerender({ currentRuntimeTask: { ...address } })
      })
      await waitFor(() =>
        expect(result.current.messages[0]?.content).toBe('Original archived prompt')
      )
      expect(load.mock.calls.length).toBeGreaterThan(archivedReadCount)
      expect(result.current.transcriptError).toBeNull()
    }
  )

  test('cancels an archived owner read without a navigation render and ignores its late error', async () => {
    const load = vi.fn<RuntimeTranscriptLoader>().mockImplementation(readRestoredTranscript)
    mocks.context.loadRuntimeTranscriptForPane = load
    const { result, rerender } = await renderSession()
    let rejectArchived!: (reason: Error) => void
    const archivedRead = new Promise<RuntimePaneTranscript>((_resolve, reject) => {
      rejectArchived = reject
    })
    load.mockReturnValueOnce(archivedRead)
    act(() => result.current.reloadRuntimeTranscript())
    await waitFor(() => expect(load.mock.calls.at(-1)?.[1]?.signal).toBeDefined())
    const signal = load.mock.calls.at(-1)?.[1]?.signal
    expect(signal?.aborted).toBe(false)
    act(() => archiveRuntimeConversation(address))
    expect(signal?.aborted).toBe(true)
    const archivedReadCount = load.mock.calls.length
    act(() => {
      rerender({ currentRuntimeTask: null })
      unmarkRuntimeConversationArchived(address)
      rerender({ currentRuntimeTask: { ...address } })
    })
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(archivedReadCount))
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe('Original archived prompt')
    )
    await act(async () => rejectArchived(new Error('late archived response')))
    expect(result.current.transcriptError).toBeNull()
    expect(result.current.messages[0]?.content).toBe('Original archived prompt')
  })

  test('retains history on ordinary navigation and unrelated conversation archival', async () => {
    const load = vi.fn<RuntimeTranscriptLoader>().mockImplementation(readRestoredTranscript)
    mocks.context.loadRuntimeTranscriptForPane = load
    const { result, rerender } = await renderSession()
    const reads = load.mock.calls.length
    act(() => {
      archiveRuntimeConversation({ ...address, taskId: 'unrelated-task' })
      rerender({ currentRuntimeTask: null })
    })
    expect(result.current.messages[0]?.content).toBe('Original archived prompt')
    expect(result.current.transcriptError).toBeNull()
    act(() => rerender({ currentRuntimeTask: { ...address } }))
    expect(load).toHaveBeenCalledTimes(reads)
    expect(result.current.messages[0]?.content).toBe('Original archived prompt')
  })

  test('keeps an explicit send independent of a reading scope replaced during dispatch', async () => {
    const { result, rerender } = await renderSession()
    act(() => result.current.clearCodeComments())
    let request!: Promise<boolean>
    act(() => {
      request = result.current.send('Explicit message without conversation references')
      rerender({ currentRuntimeTask: { ...address, threadId: 'resolved-thread' } })
    })
    await act(async () => expect(await request).toBe(true))
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        address,
        message: 'Explicit message without conversation references',
      }),
      expect.any(Object)
    )
  })

  test.each(['rejected', 'transport'] as const)(
    'rolls back a failed %s edit after its reading pane leaves',
    async outcome => {
      let resolveEdit!: (value: boolean) => void
      let rejectEdit!: (reason: Error) => void
      const edit = vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            resolveEdit = resolve
            rejectEdit = reject
          })
      )
      mocks.context.editLastUserMessage = edit
      const { result, unmount } = await renderSession()
      const originalMessage: WorkbenchMessage & { role: 'user' } = {
        id: 'original-user',
        role: 'user',
        content: 'Original question',
        status: 'done',
        createdAt: '2026-10-15T00:00:00Z',
      }
      act(() =>
        replaceRuntimeConversationSnapshot(address, [
          {
            id: 'original-turn',
            status: 'done',
            items: [
              { id: originalMessage.id, type: 'user_message', message: originalMessage },
              { id: 'original-answer', type: 'assistant_text', content: 'Original answer' },
            ],
          },
        ])
      )
      let request!: Promise<boolean>
      act(() => {
        request = result.current.editLastUserMessage(originalMessage, 'Edited question')
      })
      expect(edit).toHaveBeenCalledOnce()
      expect(getRuntimeConversationMessages(address)[0].content).toBe('Edited question')
      unmount()
      await act(async () => {
        if (outcome === 'rejected') resolveEdit(false)
        else rejectEdit(new Error('Edit transport failed'))
        expect(await request).toBe(false)
      })
      expect(getRuntimeConversationMessages(address)).toMatchObject([
        { id: originalMessage.id, content: 'Original question' },
        { content: 'Original answer' },
      ])
      expect(mocks.setError).not.toHaveBeenCalled()
    }
  )

  test.each([address, null])(
    'preserves conversation mentions when sending from pane %s',
    async currentRuntimeTask => {
      const reference = { deviceId: address.deviceId, taskId: 'referenced-task' }
      const sendCurrentInput = vi.fn().mockResolvedValue(address)
      mocks.context.sendCurrentInput = sendCurrentInput
      const { result, rerender } = await renderSession(currentRuntimeTask)
      act(() => result.current.clearCodeComments())
      const load = vi.fn<RuntimeTranscriptLoader>().mockResolvedValue({
        messages: [
          {
            id: 'referenced-message',
            role: 'user',
            content: 'Referenced conversation content',
            status: 'done',
            createdAt: '2026-10-15T00:00:00Z',
          },
        ],
        turns: [],
      })
      mocks.context.loadRuntimeTranscriptForPane = load
      rerender({ currentRuntimeTask })
      const input = createConversationMentionReference('Other conversation', reference)
      await act(async () => expect(await result.current.send(input)).toBe(true))
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining(reference),
        expect.objectContaining({
          includeFullContent: true,
          conversationContextOnly: true,
          refresh: true,
          signal: expect.any(AbortSignal),
        })
      )
      const additionalContext = currentRuntimeTask
        ? mocks.send.mock.calls[0][0].additionalContext
        : sendCurrentInput.mock.calls[0][1].additionalContext
      expect(additionalContext.referencedConversations.value).toContain(
        'Referenced conversation content'
      )
    }
  )

  test('cancels older history without publishing its error or completion into the new scope', async () => {
    const page: RuntimePaneTranscript = {
      messages: [],
      turns: [],
      hasMoreBefore: true,
      beforeCursor: 'older',
    }
    let resolveOld!: (value: RuntimePaneTranscript) => void
    let resolveReload!: (value: RuntimePaneTranscript) => void
    let resolveNext!: (value: RuntimePaneTranscript) => void
    const oldRead = new Promise<RuntimePaneTranscript>(resolve => {
      resolveOld = resolve
    })
    const reloadRead = new Promise<RuntimePaneTranscript>(resolve => {
      resolveReload = resolve
    })
    const nextRead = new Promise<RuntimePaneTranscript>(resolve => {
      resolveNext = resolve
    })
    const load = vi.fn<RuntimeTranscriptLoader>().mockResolvedValue(page)
    mocks.context.loadRuntimeTranscriptForPane = load
    const { result } = await renderSession()
    expect(result.current.transcriptBeforeCursor).toBe('older')
    load.mockImplementation((_address, options) => (options?.beforeCursor ? oldRead : reloadRead))
    const staleLoadMore = result.current.loadMoreTranscriptBefore
    let oldRequest!: Promise<void>
    act(() => {
      oldRequest = result.current.loadMoreTranscriptBefore()
    })
    const oldSignal = load.mock.calls.at(-1)?.[1]?.signal
    expect(result.current.transcriptLoadingMoreBefore).toBe(true)
    act(() => result.current.reloadRuntimeTranscript())
    await act(async () => {
      await oldRequest
    })
    expect(oldSignal?.aborted).toBe(true)
    expect(result.current.transcriptError).toBeNull()
    expect(result.current.transcriptLoading).toBe(true)
    expect(result.current.transcriptLoadingMoreBefore).toBe(false)

    await act(async () => resolveReload(page))
    expect(result.current.transcriptError).toBeNull()
    expect(result.current.transcriptLoading).toBe(false)
    const readsAfterReload = load.mock.calls.length
    await act(async () => staleLoadMore())
    expect(load).toHaveBeenCalledTimes(readsAfterReload)
    expect(result.current.transcriptLoadingMoreBefore).toBe(false)

    load.mockReturnValueOnce(nextRead)
    let nextRequest!: Promise<void>
    act(() => {
      nextRequest = result.current.loadMoreTranscriptBefore()
    })
    await act(async () => resolveOld({ ...page, beforeCursor: 'stale' }))
    expect(result.current.transcriptLoadingMoreBefore).toBe(true)
    expect(result.current.transcriptError).toBeNull()
    await act(async () => {
      resolveNext({ ...page, hasMoreBefore: false, beforeCursor: null })
      await nextRequest
    })
    expect(result.current.transcriptLoadingMoreBefore).toBe(false)
    expect(result.current.transcriptHasMoreBefore).toBe(false)
    expect(result.current.transcriptBeforeCursor).toBeNull()
  })
})

test('publishes buffered progress through the existing subscription when the queue is empty', async () => {
  const { result, unmount } = await renderSession()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const flush = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id)
      callback(0)
    }
  }
  try {
    act(() => {
      applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: 'burst' })
    })
    act(flush)
    const before = result.current.messages
    const ids = Array.from({ length: 20 }, (_, index) => `progress-${index}`)
    for (const id of ids) {
      act(() => {
        applyRuntimeConversationAction(address, {
          type: 'block_created',
          subtaskId: 'burst',
          block: { id, type: 'text', content: id, status: 'done', createdAt: 1_793_959_193_678 },
        })
      })
    }
    expect(result.current.messages === before).toBe(true)
    expect(
      getRuntimeConversationMessages(address)
        .at(-1)
        ?.blocks?.map(block => block.id)
    ).toEqual(ids)
    act(() => vi.advanceTimersByTime(99))
    expect(result.current.messages === before).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.messages.at(-1)?.blocks?.map(block => block.id)).toEqual(ids)
    expect(result.current.queuedMessages).toEqual([])
  } finally {
    unmount()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

describe('explicit composer draft replacement', () => {
  test('marks repeated same-value replacements without marking ordinary publications', async () => {
    const { result } = await renderSession()
    const initialKey = result.current.replaceDraftKey
    act(() => result.current.setInput(draft))
    act(() => result.current.onDraftEdit())
    expect(result.current.replaceDraftKey).toBe(initialKey)

    act(() => result.current.replaceInput(draft))
    expect(result.current.input).toBe(draft)
    expect(result.current.replaceDraftKey).toBe(initialKey + 1)
    act(() => result.current.replaceInput(draft))
    expect(result.current.replaceDraftKey).toBe(initialKey + 2)
  })

  test('marks editing a queued message even when its content matches the current draft', async () => {
    cacheRuntimeConversationQueuePaused(address, true)
    cacheRuntimeConversationQueuedMessages(address, [
      { id: 'queued-draft', content: draft, status: 'queued', createdAt: '2026-10-19T00:00:00Z' },
    ])
    const { result } = await renderSession()
    const initialKey = result.current.replaceDraftKey

    act(() => result.current.editQueuedMessage('queued-draft'))

    expect(result.current.input).toBe(draft)
    expect(result.current.replaceDraftKey).toBe(initialKey + 1)
    expect(result.current.queuedMessages).toEqual([])
  })

  test('marks editing the current goal even when its objective matches the current draft', async () => {
    const goal: RuntimeGoal = {
      threadId: address.threadId,
      objective: draft,
      status: 'paused',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    mocks.context.getRuntimeGoal = vi.fn().mockResolvedValue({ accepted: true, goal })
    const { result } = await renderSession()
    await waitFor(() => expect(result.current.goal?.objective).toBe(draft))
    const initialKey = result.current.replaceDraftKey

    act(() => result.current.editCurrentGoal())

    expect(result.current.input).toBe(draft)
    expect(result.current.replaceDraftKey).toBe(initialKey + 1)
    expect(result.current.goalDraftActive).toBe(true)
  })

  test('keeps an earlier scope replacement from marking the active composer', async () => {
    const { result, rerender } = await renderSession()
    const replaceEarlierScope = result.current.replaceInput
    rerender({ currentRuntimeTask: { ...address, taskId: 'another-task' } })
    const activeKey = result.current.replaceDraftKey

    act(() => replaceEarlierScope('Restored earlier scope'))

    expect(mocks.setInput).toHaveBeenCalledExactlyOnceWith(scopeKey, 'Restored earlier scope')
    expect(result.current.replaceDraftKey).toBe(activeKey)
    expect(result.current.input).toBe('')
    rerender({ currentRuntimeTask: address })
    expect(result.current.input).toBe('Restored earlier scope')
  })

  test.each(['none', 'unpublished', 'scope'] as const)(
    'restores a failed queued interrupt only while it owns the draft (change=%s)',
    async change => {
      cacheRuntimeConversationQueuePaused(address, true)
      cacheRuntimeConversationQueuedMessages(address, [
        {
          id: 'queued-interrupt',
          content: 'Queued message',
          status: 'queued',
          createdAt: '2026-10-19T00:00:00Z',
        },
      ])
      const projectChat = mocks.context.projectChat as Record<string, unknown>
      projectChat.addExistingAttachmentForScope = vi.fn()
      let finishInterrupt!: (accepted: boolean) => void
      const interrupt = vi.fn(() => new Promise<boolean>(resolve => (finishInterrupt = resolve)))
      mocks.context.interruptAndSendRuntimePaneMessage = interrupt
      const { result, rerender } = await renderSession()
      let interruption!: Promise<void>
      act(() => {
        interruption = result.current.interruptAndSendQueued('queued-interrupt')
      })
      await waitFor(() => expect(interrupt).toHaveBeenCalledOnce())
      if (change === 'unpublished') act(() => result.current.onDraftEdit())
      if (change === 'scope') {
        rerender({ currentRuntimeTask: { ...address, taskId: 'another-task' } })
      }
      const replacementKey = result.current.replaceDraftKey
      mocks.setInput.mockClear()

      await act(async () => {
        finishInterrupt(false)
        await interruption
      })

      if (change === 'none') {
        expect(mocks.setInput).toHaveBeenCalledExactlyOnceWith(
          scopeKey,
          `Queued message\n\n${draft}`
        )
        expect(result.current.replaceDraftKey).toBe(replacementKey + 1)
      } else {
        expect(mocks.setInput).not.toHaveBeenCalled()
        expect(result.current.replaceDraftKey).toBe(replacementKey)
      }
    }
  )
})

describe('composer draft ownership during delayed send acknowledgment', () => {
  test.each([false, true])(
    'clears an unchanged submitted draft after acceptance (code comments=%s)',
    async withCodeComments => {
      const { result } = await renderSession()
      if (!withCodeComments) act(() => result.current.clearCodeComments())

      await act(async () => expect(await result.current.send(draft)).toBe(true))

      expect(mocks.setInput).toHaveBeenCalledExactlyOnceWith(scopeKey, '')
    }
  )

  test.each([
    { withCodeComments: false, nextDraft: 'A newer follow-up' },
    { withCodeComments: false, nextDraft: draft },
    { withCodeComments: true, nextDraft: 'A newer follow-up' },
    { withCodeComments: true, nextDraft: draft },
  ])(
    'preserves a newer draft after acceptance (code comments=$withCodeComments, draft=$nextDraft)',
    async ({ withCodeComments, nextDraft }) => {
      let acknowledge!: (accepted: boolean) => void
      mocks.send.mockReturnValue(new Promise<boolean>(resolve => (acknowledge = resolve)))
      const { result } = await renderSession()
      if (!withCodeComments) act(() => result.current.clearCodeComments())
      let sending!: Promise<boolean>
      act(() => {
        sending = result.current.send(draft)
        // BufferedChatInput clears synchronously, before the runtime acknowledges.
        result.current.setInput('')
      })
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
      act(() => result.current.setInput(nextDraft))
      mocks.setInput.mockClear()

      await act(async () => {
        acknowledge(true)
        expect(await sending).toBe(true)
      })

      expect(mocks.setInput).not.toHaveBeenCalled()
    }
  )

  test('does not clear again when submission context resolves after the buffered clear', async () => {
    const { result } = await renderSession()
    act(() => result.current.clearCodeComments())
    // DesktopWorkbenchMain captures send, then awaits prepareSubmission. In the
    // meantime BufferedChatInput clears and may hold an unflushed new draft.
    const sendAfterPreparingContext = result.current.send
    act(() => result.current.setInput(''))
    mocks.setInput.mockClear()

    await act(async () => expect(await sendAfterPreparingContext(draft)).toBe(true))

    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.setInput).not.toHaveBeenCalled()
  })

  test('invalidates a pending clear when leaving and returning to its composer scope', async () => {
    let acknowledge!: (accepted: boolean) => void
    mocks.send.mockReturnValue(new Promise<boolean>(resolve => (acknowledge = resolve)))
    const { result, rerender } = await renderSession()
    act(() => result.current.clearCodeComments())
    let sending!: Promise<boolean>
    act(() => {
      sending = result.current.send(draft)
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    rerender({ currentRuntimeTask: { ...address, taskId: 'another-task' } })
    rerender({ currentRuntimeTask: address })
    mocks.setInput.mockClear()

    await act(async () => {
      acknowledge(true)
      expect(await sending).toBe(true)
    })

    expect(mocks.setInput).not.toHaveBeenCalled()
  })
})

describe('composer draft during an in-flight send', () => {
  test.each([true, false])(
    'preserves a newer draft after send acknowledgment (code comments=%s)',
    async withCodeComments => {
      const { result } = await renderSession()
      if (!withCodeComments) act(() => result.current.clearCodeComments())
      let acknowledgeSend!: (accepted: boolean) => void
      mocks.send.mockImplementationOnce(
        () =>
          new Promise<boolean>(resolve => {
            acknowledgeSend = resolve
          })
      )
      let submission!: Promise<boolean>
      act(() => {
        submission = result.current.send(draft)
      })
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
      // The composer clears immediately, then the user drafts the next turn.
      act(() => result.current.setInput(''))
      act(() => result.current.setInput('Next follow-up'))
      mocks.setInput.mockClear()

      await act(async () => {
        acknowledgeSend(true)
        expect(await submission).toBe(true)
      })

      expect(mocks.setInput).not.toHaveBeenCalled()
    }
  )

  test.each([true, false])(
    'keeps content added while an accepted send is pending (code comments=%s)',
    async withCodeComments => {
      const { result } = await renderSession()
      if (!withCodeComments) act(() => result.current.clearCodeComments())
      let acknowledgeSend!: (accepted: boolean) => void
      mocks.send.mockImplementationOnce(
        () =>
          new Promise<boolean>(resolve => {
            acknowledgeSend = resolve
          })
      )
      let submission!: Promise<boolean>
      act(() => {
        submission = result.current.send(draft)
      })
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
      const nextComment = { ...codeComment, id: 'next-turn-comment' }
      act(() => result.current.addCodeComment(nextComment))
      // Attachments are consumed before dispatch, never by a late acknowledgment.
      expect(mocks.resetAttachments).toHaveBeenCalledOnce()
      mocks.resetAttachments.mockClear()
      await act(async () => {
        acknowledgeSend(true)
        expect(await submission).toBe(true)
      })
      expect(result.current.codeCommentContexts).toEqual([nextComment])
      expect(mocks.resetAttachments).not.toHaveBeenCalled()
    }
  )

  test.each([false, true])(
    'cleans submitted comments while protecting annotation edits (edited=%s)',
    async edited => {
      const { result } = await renderSession()
      const annotation = {
        ...codeComment,
        id: 'submitted-annotation',
        source: 'browser_annotation' as const,
      }
      act(() => result.current.addCodeComment(annotation))
      let acknowledgeSend!: (accepted: boolean) => void
      mocks.send.mockImplementationOnce(
        () =>
          new Promise<boolean>(resolve => {
            acknowledgeSend = resolve
          })
      )
      let submission!: Promise<boolean>
      act(() => {
        submission = result.current.send(draft)
      })
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
      const nextComment = {
        ...codeComment,
        id: 'next-turn-comment',
        ...(edited ? { source: 'browser_annotation' as const } : {}),
      }
      act(() => result.current.addCodeComment(nextComment))
      await act(async () => {
        acknowledgeSend(true)
        expect(await submission).toBe(true)
      })
      expect(result.current.codeCommentContexts).toEqual(
        edited ? [annotation, nextComment] : [nextComment]
      )
      if (edited) expect(result.current.browserAnnotationCommand).toBeNull()
      else
        expect(result.current.browserAnnotationCommand).toMatchObject({
          type: 'clear_all_and_exit',
          reason: 'send_success',
        })
    }
  )

  test.each(['rejected'] as const)(
    'preserves newer text when a new-pane send is %s',
    async outcome => {
      let rejectSend!: (cause: Error) => void
      let resolveSend!: (accepted: boolean) => void
      mocks.context.sendCurrentInput = vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            resolveSend = resolve
            rejectSend = reject
          })
      )
      const { result } = await renderSession(null)
      let submission!: Promise<boolean>
      act(() => {
        submission = result.current.send(draft)
      })
      await waitFor(() => expect(mocks.context.sendCurrentInput).toHaveBeenCalledOnce())
      act(() => result.current.setInput('Next follow-up'))
      mocks.setInput.mockClear()
      await act(async () => {
        if (outcome === 'thrown') {
          const rejected = expect(submission).rejects.toThrow('Send failed')
          rejectSend(new Error('Send failed'))
          await rejected
        } else {
          resolveSend(false)
          expect(await submission).toBe(false)
        }
      })
      expect(mocks.setInput).not.toHaveBeenCalled()
    }
  )

  test.each(['preparation', 'send'] as const)(
    'does not force a failed draft over an unpublished edit during %s',
    async timing => {
      let rejectSend!: (accepted: boolean) => void
      mocks.context.sendCurrentInput = vi.fn(
        () => new Promise<boolean>(resolve => (rejectSend = resolve))
      )
      const { result } = await renderSession(null)
      const draftEditVersion = result.current.getDraftEditVersion()
      if (timing === 'preparation') act(() => result.current.onDraftEdit())
      let submission!: Promise<boolean>
      act(() => {
        submission = result.current.send(draft, { draftEditVersion })
      })
      await waitFor(() => expect(mocks.context.sendCurrentInput).toHaveBeenCalledOnce())
      if (timing === 'send') act(() => result.current.onDraftEdit())
      const replacementKey = result.current.replaceDraftKey
      mocks.setInput.mockClear()

      await act(async () => {
        rejectSend(false)
        expect(await submission).toBe(false)
      })

      expect(mocks.setInput).not.toHaveBeenCalled()
      expect(result.current.replaceDraftKey).toBe(replacementKey)
    }
  )

  test.each([true, false])(
    'restores a rejected new goal only without newer edits (edited=%s)',
    async edited => {
      let rejectGoal!: (accepted: boolean) => void
      mocks.context.sendCurrentInput = vi.fn(
        () =>
          new Promise<boolean>(resolve => {
            rejectGoal = resolve
          })
      )
      const projectChat = mocks.context.projectChat as Record<string, unknown>
      projectChat.setSelectedModelOption = vi.fn()
      const { result } = await renderSession(null)
      act(() => result.current.clearCodeComments())
      await act(async () => {
        await result.current.setCurrentGoal()
      })
      let submission!: Promise<boolean>
      act(() => {
        submission = result.current.send(draft)
      })
      await waitFor(() => expect(mocks.context.sendCurrentInput).toHaveBeenCalledOnce())
      if (edited) act(() => result.current.setInput('Next goal draft'))
      const replacementKey = result.current.replaceDraftKey
      mocks.setInput.mockClear()
      await act(async () => {
        rejectGoal(false)
        expect(await submission).toBe(false)
      })
      if (edited) {
        expect(mocks.setInput).not.toHaveBeenCalled()
        expect(result.current.replaceDraftKey).toBe(replacementKey)
      } else {
        expect(mocks.setInput).toHaveBeenCalledWith('blank-chat', draft)
        expect(result.current.replaceDraftKey).toBe(replacementKey + 1)
      }
    }
  )

  test('clears the submitted draft when no newer edit has occurred', async () => {
    const { result } = await renderSession()
    act(() => result.current.clearCodeComments())
    await act(async () => expect(await result.current.send(draft)).toBe(true))
    expect(mocks.setInput).toHaveBeenCalledWith(scopeKey, '')
  })
})

describe('pane continuation without composer submission', () => {
  test('preserves an externally replaced draft when an earlier send completes', async () => {
    let finishSend!: (accepted: boolean) => void
    mocks.send.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        finishSend = resolve
      })
    )
    const { result, rerender } = await renderSession()
    let submission!: Promise<boolean>
    act(() => {
      submission = result.current.send(draft)
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    mocks.setInput(scopeKey, 'Programmatically replaced draft')
    mocks.setInput.mockClear()
    rerender({ currentRuntimeTask: address })

    await act(async () => {
      finishSend(true)
      expect(await submission).toBe(true)
    })

    expect(result.current.input).toBe('Programmatically replaced draft')
    expect(mocks.setInput).not.toHaveBeenCalled()
  })

  test('preserves a shared draft written in the same batch as send completion', async () => {
    let finishSend!: (accepted: boolean) => void
    mocks.send.mockReturnValueOnce(new Promise<boolean>(resolve => (finishSend = resolve)))
    const context = mocks.context.projectChat as Record<string, unknown>
    const { result } = renderHook(
      () => {
        const drafts = useScopedDraftInput(() => ({ [scopeKey]: draft }))
        context.inputByScope = drafts.inputs
        context.setInputForScope = drafts.setInput
        context.getInputRevisionForScope = drafts.getRevision
        const pane = useWorkbenchPaneSession({
          currentRuntimeTask: address,
          debugSnapshotEnabled: false,
        })
        return { pane, drafts }
      },
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(RuntimeTaskLifecycleProvider, { store: lifecycleStore, children }),
      }
    )
    await waitFor(() => expect(result.current.pane.transcriptLoading).toBe(false))
    let submission!: Promise<boolean>
    act(() => {
      submission = result.current.pane.send(draft)
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    await act(async () => {
      result.current.drafts.setInput(scopeKey, 'Shared replacement before commit')
      finishSend(true)
      expect(await submission).toBe(true)
    })
    expect(result.current.pane.input).toBe('Shared replacement before commit')
  })

  test('does not clear a shared draft after the submitting pane unmounts', async () => {
    let finishSend!: (accepted: boolean) => void
    mocks.send.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        finishSend = resolve
      })
    )
    const { result, unmount } = await renderSession()
    let submission!: Promise<boolean>
    act(() => {
      submission = result.current.send(draft)
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    unmount()

    await act(async () => {
      finishSend(true)
      expect(await submission).toBe(true)
    })

    expect(mocks.setInput).not.toHaveBeenCalled()
  })

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
    rerender({ currentRuntimeTask: address })

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

describe('unbound pane conversation search', () => {
  test('finds and navigates loaded messages without attempting a persisted transcript search', async () => {
    const searchTranscript = vi.fn()
    mocks.context.searchRuntimeTranscriptForPane = searchTranscript
    const messages: WorkbenchMessage[] = [
      {
        id: 'loaded-message',
        role: 'assistant',
        content: 'needle first; needle second',
        status: 'done',
        createdAt: '2026-10-20T00:00:00Z',
      },
    ]
    const { result } = renderHook(
      () => {
        const pane = useWorkbenchPaneSession({
          currentRuntimeTask: null,
          debugSnapshotEnabled: false,
        })
        const find = useConversationFind(
          {
            messages,
            onSearchTranscript: pane.searchTranscript,
            onEnsureSearchMatch: pane.ensureSearchMatch,
          },
          true
        )
        return { pane, find }
      },
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(RuntimeTaskLifecycleProvider, { store: lifecycleStore, children }),
      }
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => {
      fireEvent.keyDown(window, {
        key: 'f',
        metaKey: getPlatform() === 'mac',
        ctrlKey: getPlatform() !== 'mac',
      })
      result.current.find.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))

    expect(result.current.find.result).toEqual({ matches: 2, active: 1, isCapped: false })
    expect(result.current.find.historyFailed).toBe(false)
    expect(result.current.find.isLoading).toBe(false)
    act(() => result.current.find.step(1))
    expect(result.current.find.result.active).toBe(2)
    expect(result.current.find.searchTarget?.occurrence).toBe(1)
    expect(searchTranscript).not.toHaveBeenCalled()
  })
})

describe('composer cancellation rollback', () => {
  test.each(
    ['usageLimited', 'blocked'].flatMap(status => [
      { status, accepted: true },
      { status, accepted: false },
    ]) as { status: 'usageLimited' | 'blocked'; accepted: boolean }[]
  )(
    'pauses a $status quota goal before cancelling recovery (accepted=$accepted)',
    async ({ status, accepted }) => {
      const goal: RuntimeGoal = {
        threadId: address.threadId,
        objective: 'Finish the original task',
        status,
        tokenBudget: 2000,
        tokensUsed: 300,
        timeUsedSeconds: 10,
        createdAt: 1,
        updatedAt: 1,
      }
      lifecycleStore.syncRuntimeTask(address, {
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        title: 'Quota goal',
        runtime: 'codex',
        running: false,
        continuable: true,
        goalStatus: status,
        runtimeHandle: { quotaWait: { resumeAt: Date.now() + 60_000 } },
      })
      const order: string[] = []
      mocks.context.getRuntimeGoal = vi.fn().mockResolvedValue({ accepted: true, goal })
      const pause = vi.fn().mockImplementation(async () => {
        order.push('pause')
        return { accepted, goal: { ...goal, status: 'paused' } }
      })
      mocks.context.setRuntimeGoal = pause
      mocks.cancel.mockImplementation(async () => {
        order.push('cancel')
        return true
      })
      const { result } = await renderSession()
      await waitFor(() => expect(result.current.goal?.status).toBe(status))
      await act(async () => {
        await result.current.pauseCurrentResponse()
      })
      expect(pause).toHaveBeenCalledExactlyOnceWith({ address, status: 'paused' })
      expect(order).toEqual(accepted ? ['pause', 'cancel'] : ['pause'])
    }
  )

  test('a delayed cancellation acknowledgement cannot stop the next native turn', async () => {
    const { result } = await renderSession()
    let acknowledge!: (accepted: boolean) => void
    mocks.cancel.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          acknowledge = resolve
        })
    )
    let stopping!: Promise<void>
    act(() => {
      applyRuntimeConversationAction(address, {
        type: 'assistant_started',
        subtaskId: 'cancelled-native-turn',
      })
      stopping = result.current.pauseCurrentResponse()
    })
    await act(async () => {
      applyRuntimeConversationAction(address, {
        type: 'assistant_error',
        subtaskId: 'cancelled-native-turn',
        error: 'cancelled',
      })
      applyRuntimeConversationAction(address, {
        type: 'assistant_started',
        subtaskId: 'next-native-turn',
      })
      acknowledge(true)
      await stopping
      applyRuntimeConversationAction(address, {
        type: 'assistant_chunk',
        subtaskId: 'next-native-turn',
        itemId: 'follow-up-answer',
        content: 'The next native answer stays visible.',
      })
    })
    expect(getRuntimeConversationMessages(address)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtaskId: 'next-native-turn',
          status: 'streaming',
          content: 'The next native answer stays visible.',
        }),
      ])
    )
  })

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

test.each([true, false])(
  'settles the whole async group after guidance without a turn ID (accepted=%s)',
  async accepted => {
    const { result } = await renderSession()
    mocks.guide.mockResolvedValueOnce({ sent: accepted })
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
    expect(mocks.guide).toHaveBeenCalledOnce()
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
