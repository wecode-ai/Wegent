import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import type { RuntimeTaskAddress, RuntimeTaskSummary, RuntimeTranscriptResponse } from '@/types/api'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  getRuntimeConversationTurns,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import {
  useBoardRuntimeConversations,
  type UseBoardRuntimeConversationsOptions,
} from './useBoardRuntimeConversations'

const address: RuntimeTaskAddress = {
  deviceId: 'app-record-65',
  taskId: 'runtime-task-1',
  runtime: 'codex',
  threadId: 'thread-1',
  workspacePath: '/repo',
  runtimeHandle: { modelSelection: { modelName: 'test-model', modelType: 'public' } },
  projectSession: { projectId: 'project-1', issueId: 'issue-1' },
}
const reviewItem = {
  id: 'issue-1',
  cloud_project_id: 'project-1',
  status: 'in_review',
  execution_state: 'succeeded',
} as CloudLoopItem

function task(updatedAt: number): RuntimeTaskSummary {
  return {
    taskId: address.taskId,
    runtime: 'codex',
    title: 'Run the assigned task',
    workspacePath: '/repo',
    running: false,
    updatedAt,
  }
}

function transcript(turnId: string, fullContent = true): RuntimeTranscriptResponse {
  return {
    taskId: address.taskId,
    workspacePath: '/repo',
    runtime: 'codex',
    running: false,
    fullContent,
    messages: [],
    turns: [
      {
        id: turnId,
        status: 'done',
        items: [{ id: `${turnId}-assistant`, type: 'assistant_text', content: turnId }],
      },
    ],
  }
}

function deferredTranscript() {
  let resolve!: (response: RuntimeTranscriptResponse) => void
  const promise = new Promise<RuntimeTranscriptResponse>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function options(
  getRuntimeTranscript: NonNullable<UseBoardRuntimeConversationsOptions['getRuntimeTranscript']>,
  overrides: Partial<UseBoardRuntimeConversationsOptions> = {}
): UseBoardRuntimeConversationsOptions {
  return {
    item: reviewItem,
    conversations: [{ address }],
    enabled: true,
    getRuntimeTranscript,
    ...overrides,
  }
}

describe('useBoardRuntimeConversations', () => {
  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    vi.restoreAllMocks()
  })

  it('restores a cold review conversation using its binding context without a sidebar task', async () => {
    const getRuntimeTranscript = vi.fn().mockResolvedValue(transcript('completed-reply'))

    renderHook(() => useBoardRuntimeConversations(options(getRuntimeTranscript)))

    expect(getRuntimeTranscript).toHaveBeenCalledExactlyOnceWith({
      ...address,
      limit: 20,
      includeFullContent: true,
    })
    await waitFor(() =>
      expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['completed-reply'])
    )
  })

  it('waits for the board to become active and ignores settled Issues outside review', () => {
    const getRuntimeTranscript = vi.fn().mockResolvedValue(transcript('completed-reply'))
    const { rerender } = renderHook(props => useBoardRuntimeConversations(props), {
      initialProps: options(getRuntimeTranscript, { enabled: false }),
    })
    expect(getRuntimeTranscript).not.toHaveBeenCalled()

    rerender(
      options(getRuntimeTranscript, {
        item: { ...reviewItem, status: 'completed' },
      })
    )
    expect(getRuntimeTranscript).not.toHaveBeenCalled()

    rerender(options(getRuntimeTranscript))
    expect(getRuntimeTranscript).toHaveBeenCalledOnce()
  })

  it('loads an active execution and requests bounded content while it is running', () => {
    const getRuntimeTranscript = vi.fn().mockResolvedValue(transcript('running-reply', false))

    renderHook(() =>
      useBoardRuntimeConversations(
        options(getRuntimeTranscript, {
          item: { ...reviewItem, status: 'in_progress', execution_state: 'running' },
          conversations: [{ address, task: { ...task(1), running: true } }],
        })
      )
    )

    expect(getRuntimeTranscript).toHaveBeenCalledExactlyOnceWith({
      ...address,
      limit: 20,
      includeFullContent: false,
    })
  })

  it('attempts a failed signature once and reloads when task metadata changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const getRuntimeTranscript = vi.fn().mockRejectedValue(new Error('thread not loaded'))
    const props = options(getRuntimeTranscript, { conversations: [{ address, task: task(1) }] })
    const { rerender } = renderHook(value => useBoardRuntimeConversations(value), {
      initialProps: props,
    })
    await waitFor(() => expect(console.warn).toHaveBeenCalledOnce())

    rerender({ ...props, conversations: [{ address: { ...address }, task: task(1) }] })
    expect(getRuntimeTranscript).toHaveBeenCalledOnce()

    rerender({ ...props, conversations: [{ address, task: task(2) }] })
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
  })

  it('loads newly available binding context without requiring sidebar metadata', async () => {
    const getRuntimeTranscript = vi.fn().mockResolvedValue(transcript('completed-reply'))
    const props = options(getRuntimeTranscript, {
      conversations: [{ address: { deviceId: address.deviceId, taskId: address.taskId } }],
    })
    const { rerender } = renderHook(value => useBoardRuntimeConversations(value), {
      initialProps: props,
    })
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledOnce())

    rerender(options(getRuntimeTranscript))

    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      ...address,
      limit: 20,
      includeFullContent: true,
    })
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(2)
  })

  it('rejects a stale preload after a newer response has been applied', async () => {
    const older = deferredTranscript()
    const newer = deferredTranscript()
    const getRuntimeTranscript = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const props = options(getRuntimeTranscript, { conversations: [{ address, task: task(1) }] })
    const { rerender } = renderHook(value => useBoardRuntimeConversations(value), {
      initialProps: props,
    })
    rerender({ ...props, conversations: [{ address, task: task(2) }] })

    await act(async () => newer.resolve(transcript('newer-reply')))
    await act(async () => older.resolve(transcript('older-reply')))

    expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['newer-reply'])
  })

  it('applies a completed response while a newer signature is still pending', async () => {
    const completed = deferredTranscript()
    const pending = deferredTranscript()
    const getRuntimeTranscript = vi
      .fn()
      .mockReturnValueOnce(completed.promise)
      .mockReturnValueOnce(pending.promise)
    const props = options(getRuntimeTranscript, { conversations: [{ address, task: task(1) }] })
    const { rerender } = renderHook(value => useBoardRuntimeConversations(value), {
      initialProps: props,
    })
    rerender({ ...props, conversations: [{ address, task: task(2) }] })

    await act(async () => completed.resolve(transcript('completed-reply')))

    expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['completed-reply'])
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(2)
  })

  it('ignores an unmounted card response after its replacement has restored the conversation', async () => {
    const oldCardResponse = deferredTranscript()
    const newCardResponse = deferredTranscript()
    const getRuntimeTranscript = vi
      .fn()
      .mockReturnValueOnce(oldCardResponse.promise)
      .mockReturnValueOnce(newCardResponse.promise)
    const oldCard = renderHook(() => useBoardRuntimeConversations(options(getRuntimeTranscript)))
    oldCard.unmount()
    renderHook(() => useBoardRuntimeConversations(options(getRuntimeTranscript)))

    await act(async () => newCardResponse.resolve(transcript('current-reply')))
    await act(async () => oldCardResponse.resolve(transcript('stale-reply')))

    expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['current-reply'])
  })

  it('replaces cached turns with a full idle transcript', async () => {
    replaceRuntimeConversationSnapshot(address, transcript('obsolete-reply').turns)
    const getRuntimeTranscript = vi.fn().mockResolvedValue(transcript('current-reply'))

    renderHook(() => useBoardRuntimeConversations(options(getRuntimeTranscript)))

    await waitFor(() =>
      expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['current-reply'])
    )
  })

  it.each(['pending', 'streaming', 'done'] as const)(
    'keeps a %s follow-up when an older full idle board preload returns',
    async status => {
      const completed = transcript('completed-reply')
      completed.turns[0].position = 1
      replaceRuntimeConversationSnapshot(address, completed.turns)
      const preload = deferredTranscript()
      const getRuntimeTranscript = vi.fn().mockReturnValue(preload.promise)
      renderHook(() => useBoardRuntimeConversations(options(getRuntimeTranscript)))
      expect(getRuntimeTranscript).toHaveBeenCalledOnce()

      act(() => {
        applyRuntimeConversationAction(address, {
          type: 'user_added',
          message: { id: 'follow-up', role: 'user', content: 'New question', status: 'done' },
        })
        if (status === 'pending') return
        applyRuntimeConversationAction(address, {
          type: 'assistant_started',
          subtaskId: 'live-turn',
          clientUserMessageId: 'follow-up',
        })
        applyRuntimeConversationAction(address, {
          type: 'assistant_chunk',
          subtaskId: 'live-turn',
          itemId: 'live-text',
          content: 'Visible live reply',
        })
        if (status === 'done')
          applyRuntimeConversationAction(address, {
            type: 'assistant_done',
            subtaskId: 'live-turn',
          })
      })
      const expectedContent = [
        'completed-reply',
        'New question',
        ...(status === 'pending' ? [] : ['Visible live reply']),
      ]
      expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual(
        expectedContent
      )

      await act(async () => preload.resolve(completed))

      expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual(
        expectedContent
      )
      expect(getRuntimeConversationTurns(address).at(-1)?.status).toBe(status)
    }
  )

  it('preserves older turns when the preload transcript is bounded', async () => {
    replaceRuntimeConversationSnapshot(address, transcript('older-reply').turns)
    const getRuntimeTranscript = vi.fn().mockResolvedValue(transcript('newer-reply', false))

    renderHook(() => useBoardRuntimeConversations(options(getRuntimeTranscript)))

    await waitFor(() => {
      const turns = getRuntimeConversationTurns(address)
      expect(turns).toHaveLength(2)
      expect(turns.map(turn => turn.id)).toEqual(
        expect.arrayContaining(['older-reply', 'newer-reply'])
      )
    })
  })

  it('does not resurrect obsolete turns after another viewer replaces the history', async () => {
    replaceRuntimeConversationSnapshot(address, transcript('obsolete-reply').turns)
    const preload = deferredTranscript()
    renderHook(() => useBoardRuntimeConversations(options(vi.fn(() => preload.promise))))
    act(() => replaceRuntimeConversationSnapshot(address, transcript('current-reply').turns))

    await act(async () => preload.resolve(transcript('obsolete-reply')))

    expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['current-reply'])
  })
})
