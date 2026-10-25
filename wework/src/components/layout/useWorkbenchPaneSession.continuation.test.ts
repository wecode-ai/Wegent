import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode, useCallback, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { useConversationFind } from '@/components/chat/useConversationFind'
import { getPlatform } from '@/lib/platform'
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
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'

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

async function renderComposerSession() {
  const projectChat = mocks.context.projectChat as Record<string, unknown>
  const hook = renderHook(
    ({ task }: { task: RuntimeTaskAddress }) => {
      const [inputByScope, setInputByScope] = useState({ [scopeKey]: draft })
      const setInputForScope = useCallback((key: string, value: string) => {
        mocks.setInput(key, value)
        setInputByScope(current => ({ ...current, [key]: value }))
      }, [])
      mocks.context = {
        ...mocks.context,
        projectChat: {
          ...projectChat,
          inputByScope,
          attachmentStateByScope: {},
          setInputForScope,
        },
      }
      return useWorkbenchPaneSession({ currentRuntimeTask: task, debugSnapshotEnabled: false })
    },
    {
      initialProps: { task: address as RuntimeTaskAddress },
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(RuntimeTaskLifecycleProvider, { store: lifecycleStore, children }),
    }
  )
  await waitFor(() => expect(hook.result.current.transcriptLoading).toBe(false))
  return hook
}

function deferAcceptedSendRefresh(queued = false) {
  let finishRefresh: () => void = () => undefined
  const refresh = new Promise<void>(resolve => {
    finishRefresh = resolve
  })
  mocks.send.mockImplementation(async (_request, options) => {
    if (queued) options.onQueued({ queuePosition: 2 })
    await refresh
    return true
  })
  return finishRefresh
}

describe('composer submission draft ownership', () => {
  test.each(['A newly typed follow-up', draft])(
    'preserves the published next draft %j while an accepted send finishes refreshing',
    async nextDraft => {
      const finishRefresh = deferAcceptedSendRefresh()
      const { result } = await renderComposerSession()
      let submission: Promise<boolean> = Promise.resolve(false)
      act(() => {
        submission = result.current.send()
      })
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
      act(() => result.current.setInput(nextDraft))

      await act(async () => {
        finishRefresh()
        expect(await submission).toBe(true)
      })

      expect(result.current.input).toBe(nextDraft)
      expect(mocks.setInput).not.toHaveBeenCalledWith(scopeKey, '')
    }
  )

  test('preserves identical unflushed text after an immediate draft edit', async () => {
    const finishRefresh = deferAcceptedSendRefresh()
    const { result } = await renderComposerSession()
    let submission: Promise<boolean> = Promise.resolve(false)
    act(() => {
      submission = result.current.send()
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())

    // The editor has changed, but its debounce has not published a new value.
    act(() => result.current.markDraftEdited())
    expect(result.current.input).toBe(draft)
    await act(async () => {
      finishRefresh()
      expect(await submission).toBe(true)
    })

    expect(result.current.input).toBe(draft)
    expect(mocks.setInput).not.toHaveBeenCalled()
    expect(mocks.setError).toHaveBeenLastCalledWith(scopeKey, null)
  })

  test('does not clear again after the buffered composer publishes its synchronous clear', async () => {
    const finishRefresh = deferAcceptedSendRefresh()
    const { result } = await renderComposerSession()
    let submission: Promise<boolean> = Promise.resolve(false)
    act(() => {
      submission = result.current.send()
      result.current.setInput('')
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    mocks.setInput.mockClear()

    await act(async () => {
      finishRefresh()
      expect(await submission).toBe(true)
    })

    expect(result.current.input).toBe('')
    expect(mocks.setInput).not.toHaveBeenCalled()
  })

  test.each(['code-comment', 'queued', 'interrupt'] as const)(
    'preserves a newer draft after an accepted %s submission',
    async mode => {
      const finishRefresh = deferAcceptedSendRefresh(mode === 'queued')
      mocks.context.interruptAndSendRuntimePaneMessage = mocks.send
      const { result } = await renderComposerSession()
      if (mode === 'code-comment') act(() => result.current.addCodeComment(codeComment))
      if (mode === 'interrupt') act(() => lifecycleStore.turnStarted(address, 'active-turn'))
      let submission: Promise<boolean> = Promise.resolve(false)
      act(() => {
        submission = result.current.send(undefined, { interruptWhenBusy: mode === 'interrupt' })
      })
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
      act(() => result.current.setInput('The next unsent draft'))

      await act(async () => {
        finishRefresh()
        expect(await submission).toBe(true)
      })

      expect(result.current.input).toBe('The next unsent draft')
      expect(mocks.setInput).not.toHaveBeenCalledWith(scopeKey, '')
    }
  )

  test('does not clear the original scope after switching away and back', async () => {
    const finishRefresh = deferAcceptedSendRefresh()
    const { result, rerender } = await renderComposerSession()
    let submission: Promise<boolean> = Promise.resolve(false)
    act(() => {
      submission = result.current.send()
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    rerender({ task: { ...address, taskId: 'another-task' } })
    rerender({ task: address })

    await act(async () => {
      finishRefresh()
      await submission
    })

    expect(result.current.input).toBe(draft)
    expect(mocks.setInput).not.toHaveBeenCalledWith(scopeKey, '')
  })

  test('does not grant the active scope ownership to a retained send callback', async () => {
    const finishRefresh = deferAcceptedSendRefresh()
    const { result, rerender } = await renderComposerSession()
    const originalSend = result.current.send
    rerender({ task: { ...address, taskId: 'another-task' } })
    act(() => result.current.setInput('Another task draft'))
    let submission: Promise<boolean> = Promise.resolve(false)
    act(() => {
      submission = originalSend()
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())

    await act(async () => {
      finishRefresh()
      await submission
    })

    expect(result.current.input).toBe('Another task draft')
    rerender({ task: address })
    expect(result.current.input).toBe(draft)
    expect(mocks.setInput).not.toHaveBeenCalledWith(scopeKey, '')
  })

  test.each([true, false])(
    'keeps the untouched direct-send outcome when accepted=%s',
    async accepted => {
      mocks.send.mockResolvedValue(accepted)
      const { result } = await renderComposerSession()

      await act(async () => expect(await result.current.send()).toBe(accepted))

      expect(result.current.input).toBe(accepted ? '' : draft)
      expect(mocks.setInput).toHaveBeenCalledTimes(accepted ? 1 : 0)
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

  test.each(['rejected', 'thrown'] as const)(
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
      mocks.setInput.mockClear()
      await act(async () => {
        rejectGoal(false)
        expect(await submission).toBe(false)
      })
      if (edited) expect(mocks.setInput).not.toHaveBeenCalled()
      else expect(mocks.setInput).toHaveBeenCalledWith('blank-chat', draft)
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
