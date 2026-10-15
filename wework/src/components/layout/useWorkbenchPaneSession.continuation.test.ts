import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'
import { useWorkbenchPaneSession } from './useWorkbenchPaneSession'

const mocks = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  send: vi.fn(),
  setInput: vi.fn(),
  resetAttachments: vi.fn(),
  setError: vi.fn(),
  store: { getTask: vi.fn(), syncTranscript: vi.fn(), goalStatusReceived: vi.fn() },
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => mocks.context,
}))
vi.mock('@/features/workbench/runtimeTaskLifecycle', async original => ({
  ...(await original<typeof import('@/features/workbench/runtimeTaskLifecycle')>()),
  useRuntimeTaskLifecycle: () => null,
  useRuntimeTaskLifecycleStore: () => mocks.store,
}))

const address: RuntimeTaskAddress = {
  deviceId: 'original-device',
  taskId: 'original-task',
  threadId: 'original-thread',
  workspacePath: '/workspace/original',
}
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.send.mockResolvedValue(true)
  mocks.store.getTask.mockReturnValue(null)
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
    getRuntimeGoal: vi.fn().mockResolvedValue({ accepted: false }),
    loadRuntimeTranscriptForPane: vi.fn().mockResolvedValue({ messages: [], turns: [] }),
    refreshWorkLists: vi.fn().mockResolvedValue(undefined),
  }
})

afterEach(clearRuntimeConversationCacheForTests)

async function renderSession(currentRuntimeTask: RuntimeTaskAddress | null = address) {
  const hook = renderHook(() =>
    useWorkbenchPaneSession({ currentRuntimeTask, debugSnapshotEnabled: false })
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

  test('keeps a busy rejection queued until the task lifecycle changes', async () => {
    mocks.send.mockImplementation(async (_request, options) => {
      options.onError('runtime task is already running')
      return false
    })
    const { result, rerender } = await renderSession()

    await act(async () => expect(await result.current.sendContinuation(continuation)).toBe(true))
    rerender()

    expect(result.current.queuedMessages).toMatchObject([
      { content: continuation, status: 'queued' },
    ])
    expect(mocks.send).toHaveBeenCalledOnce()
    expectDraftPreserved(result.current)
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
