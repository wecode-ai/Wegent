import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  applyRequestUserInputResponseToBlock,
  isAsyncRequestUserInputPayload,
} from '@wegent/chat-core/runtime-user-input'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  replaceRuntimeConversationSnapshot,
  updateRuntimeConversationBlocks,
} from '@/features/workbench/runtimeConversationCache'
import { projectRuntimePaneTranscript } from '@/features/workbench/runtimeTaskLifecycle/projection'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'
import { interactionResponse } from './runtimeInteractions'
import * as diagnostics from './interactionDiagnostics'
import { issueHumanInteraction } from './issueHumanInteractions'
import { useRuntimeInteractionSettlements } from './useRuntimeInteractionSettlements'
import { archiveInteraction } from './interactionStorage'

const historyKey = 'wework.interactions:test:1:history'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => (resolve = complete))
  return { promise, resolve }
}

beforeEach(() => clearRuntimeConversationCacheForTests())
afterEach(() => clearRuntimeConversationCacheForTests())

function cacheQuestion(
  payload: RequestUserInputPayload = interactionQuestion,
  turnId = 'turn-1',
  address = interactionTask.address
) {
  const scoped = isAsyncRequestUserInputPayload(payload)
    ? payload
    : { ...payload, interactionScope: turnId }
  replaceRuntimeConversationSnapshot(address, [
    {
      id: turnId,
      status: 'completed',
      items: projectRuntimePaneTranscript(
        interactionTranscript(scoped, turnId)
      ).messages[0].blocks!.map(block => ({ id: block.id, type: 'block', block })),
    },
  ])
}

it.each(['async', 'synchronous'])(
  'archives an accepted %s task answer immediately while persisted history is stale',
  async delivery => {
    const payload = {
      ...interactionQuestion,
      delivery: delivery === 'async' ? 'async' : undefined,
    }
    const rendered = view(payload)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    const reads = harness.transcript.mock.calls.length
    act(() => {
      cacheQuestion(payload)
      updateRuntimeConversationBlocks(interactionTask.address, block =>
        applyRequestUserInputResponseToBlock(
          block,
          interactionResponse(item.payload, { compatibility: { answers: ['keep'] } })
        )
      )
    })
    expect(getRuntimeConversationMessages(interactionTask.address)[0].blocks![0]).toMatchObject({
      renderPayload: { response: { answers: { compatibility: { answers: ['keep'] } } } },
    })
    await waitFor(() => expect(context!.pending).toHaveLength(0))
    expect(context!.history).toEqual([expect.objectContaining({ id: item.id })])
    expect(context!.notice).toBeNull()
    expect(harness.transcript).toHaveBeenCalledTimes(reads)
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.guide).not.toHaveBeenCalled()

    await act(async () => context!.refresh())
    expect(context!.pending).toHaveLength(0)
    rendered.unmount()
    clearRuntimeConversationCacheForTests()
    view(payload)
    await waitFor(() => expect(context!.loading).toBe(false))
    expect(context!.pending).toHaveLength(0)
    expect(context!.history).toEqual([expect.objectContaining({ id: item.id })])
  }
)

it('does not settle another task or an unanswered request when cached history is replaced', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  await act(async () => {
    cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }, 'turn-1', {
      ...interactionTask.address,
      taskId: 'another-task',
    })
    cacheQuestion()
    replaceRuntimeConversationSnapshot(interactionTask.address, [])
  })
  expect(context!.pending).toHaveLength(1)
  expect(context!.history).toHaveLength(0)
})

it('does not let a reused synchronous request ID from an older turn settle a new question', async () => {
  const payload = { ...interactionQuestion, delivery: undefined, requestId: 1 }
  view(payload)
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  await act(async () => cacheQuestion({ ...payload, interactionStatus: 'answered' }, 'old-turn'))
  expect(context!.pending).toHaveLength(1)
  expect(context!.history).toHaveLength(0)
})

it('settles a discovered question whose answer was already accepted before subscription', async () => {
  cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' })
  view()
  await waitFor(() => expect(context!.history).toHaveLength(1))
  expect(context!.pending).toHaveLength(0)
})

it('settles an async composer answer only after delivery, not while it is queued', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const message = { id: 'reply', role: 'user', content: 'keep', status: 'pending' }
  await act(async () => {
    cacheQuestion()
    applyRuntimeConversationAction(interactionTask.address, { type: 'user_added', message })
  })
  expect(context!.pending).toHaveLength(1)
  expect(context!.history).toHaveLength(0)
  act(() => {
    // Accepted history replaces the optimistic, undelivered user message.
    cacheQuestion()
    applyRuntimeConversationAction(interactionTask.address, {
      type: 'user_added',
      message: { ...message, status: 'done' },
    })
  })
  await waitFor(() => expect(context!.pending).toHaveLength(0))
  expect(context!.history).toHaveLength(1)
  expect(harness.send).not.toHaveBeenCalled()
})

it('retains the question on archive failure and recovers on a subsequent cache update without resending', async () => {
  const log = vi.spyOn(diagnostics, 'logInteractionLoadFailure').mockImplementation(() => {})
  const failure = new Error('Storage unavailable')
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  harness.flushStorage.mockRejectedValue(failure)
  await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
  await waitFor(() => expect(log).toHaveBeenCalledWith('archive', failure, interactionTask.address))
  expect(context!.pending).toHaveLength(1)
  expect(context!.history).toHaveLength(0)
  harness.flushStorage.mockResolvedValue(undefined)
  await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
  await waitFor(() => expect(context!.pending).toHaveLength(0))
  expect(context!.history).toHaveLength(1)
  expect(harness.send).not.toHaveBeenCalled()
})

it('serializes settlement and stale replies while the history lock is held', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  const historyGate = deferred<void>()
  const transcriptGate = deferred<ReturnType<typeof interactionTranscript>>()
  harness.locks.set(historyKey, historyGate.promise)
  const lock = vi.spyOn(navigator.locks, 'request')
  await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
  await waitFor(() => expect(lock).toHaveBeenCalledWith(historyKey, expect.any(Function)))
  const reads = harness.transcript.mock.calls.length
  harness.transcript.mockReturnValueOnce(transcriptGate.promise)
  let response!: Promise<boolean>
  act(() => {
    response = context!.respond(item, 'Late duplicate')
  })
  await act(async () => historyGate.resolve())
  await waitFor(() => expect(context!.history).toHaveLength(1))
  await act(async () => {
    transcriptGate.resolve(interactionTranscript())
    expect(await response).toBe(false)
  })
  expect(harness.transcript).toHaveBeenCalledTimes(reads)
  expect(harness.send).not.toHaveBeenCalled()
  expect(harness.guide).not.toHaveBeenCalled()
  expect(context!.pending).toHaveLength(0)
})

it('preserves a failed native reply visibly after concurrent task settlement and reload', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  harness.desktop = true
  const delivery = deferred<{ accepted: boolean; error: string }>()
  harness.send.mockReturnValueOnce(delivery.promise)
  let replies = [{ id: 'native-concurrent', interactionId: '', text: 'Do not lose this reply' }]
  harness.host.mockImplementation(async (command: string) => {
    if (command === 'notification.pendingReplies') return replies[0]?.interactionId ? replies : []
    if (command === 'notification.acknowledgeReply') replies = []
  })
  const rendered = view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  replies[0].interactionId = item.id
  act(() => harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' })))
  await waitFor(() => expect(harness.send).toHaveBeenCalledOnce())
  await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
  await act(async () => delivery.resolve({ accepted: false, error: 'Offline' }))
  await waitFor(() => expect(replies).toEqual([]))
  await waitFor(() => expect(context!.pending).toHaveLength(0))
  expect(context!.history).toEqual([expect.objectContaining({ id: item.id })])
  expect(context!.drafts[item.id]).toBe('Do not lose this reply')
  expect(context!.replyDrafts).toEqual([
    expect.objectContaining({ text: 'Do not lose this reply' }),
  ])
  expect(context!.errors[item.id]).toBe('interactions.failed')
  await waitFor(() =>
    expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('Do not lose this reply')
  )
  rendered.unmount()
  clearRuntimeConversationCacheForTests()
  view()
  await waitFor(() => expect(context!.loading).toBe(false))
  expect(context!.pending).toHaveLength(0)
  expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('Do not lose this reply')
  fireEvent.click(screen.getByTestId('interaction-discard-unsent'))
  await waitFor(() => expect(context!.drafts[item.id]).toBeUndefined())
  expect(screen.queryByTestId('interaction-unsent-text')).not.toBeInTheDocument()
  expect(harness.send).toHaveBeenCalledOnce()
})

it.each(['before', 'after'])(
  'preserves a native reply queued %s task settlement without resending',
  async timing => {
    harness.desktop = true
    let replies = [{ id: 'native-settled', interactionId: '', text: 'A late native reply' }]
    harness.host.mockImplementation(async (command: string) => {
      if (command === 'notification.pendingReplies') return replies[0]?.interactionId ? replies : []
      if (command === 'notification.acknowledgeReply') replies = []
    })
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    const historyGate = deferred<void>()
    if (timing === 'before') harness.locks.set(historyKey, historyGate.promise)
    await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
    if (timing === 'after') await waitFor(() => expect(context!.pending).toHaveLength(0))
    replies[0].interactionId = item.id
    act(() => harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' })))
    if (timing === 'before') {
      await waitFor(() => expect(context!.busy.has(item.id)).toBe(true))
      await act(async () => historyGate.resolve())
    }
    await waitFor(() => expect(replies).toEqual([]))
    await waitFor(() => expect(context!.pending).toHaveLength(0))
    expect(context!.drafts[item.id]).toBe('A late native reply')
    expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('A late native reply')
    expect(harness.send).not.toHaveBeenCalled()
  }
)

it.each(['delayed', 'failed'])(
  'does not acknowledge a settled native reply before its recovery text is durably saved (%s)',
  async storage => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.desktop = true
    let replies = [{ id: 'native-durable', interactionId: '', text: 'Keep until disk commits' }]
    harness.host.mockImplementation(async (command: string) => {
      if (command === 'notification.pendingReplies') return replies[0]?.interactionId ? replies : []
      if (command === 'notification.acknowledgeReply') replies = []
    })
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
    await waitFor(() => expect(context!.pending).toHaveLength(0))
    const gate = deferred<void>()
    if (storage === 'delayed') harness.flushStorage.mockReturnValue(gate.promise)
    else harness.flushStorage.mockRejectedValue(new Error('Disk unavailable'))
    replies[0].interactionId = item.id
    await act(async () =>
      harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' }))
    )
    expect(replies).toHaveLength(1)
    expect(harness.host).not.toHaveBeenCalledWith(
      'notification.acknowledgeReply',
      expect.anything()
    )
    expect(localStorage.getItem('wework.interactions:test:1:native-replies') ?? '').not.toContain(
      'native-durable'
    )
    harness.flushStorage.mockResolvedValue(undefined)
    await act(async () => gate.resolve())
    if (storage === 'failed') {
      await act(async () =>
        harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' }))
      )
    }
    await waitFor(() => expect(replies).toEqual([]))
    expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('Keep until disk commits')
  }
)

it('keeps unsent text reachable after more than 100 subsequent archives and a reload', async () => {
  const first = view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  act(() => context!.setDraft(item.id, 'Older unsent text'))
  await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
  await waitFor(() => expect(context!.pending).toHaveLength(0))
  const newer = Array.from({ length: 101 }, (_, index) => ({
    ...context!.history[0],
    id: `newer-${index}`,
    answeredAt: Date.now() + index + 1,
  })).reduce((history, entry) => archiveInteraction(history, entry), context!.history)
  localStorage.setItem(historyKey, JSON.stringify(newer))
  first.unmount()
  clearRuntimeConversationCacheForTests()
  view()
  await waitFor(() => expect(context!.loading).toBe(false))
  expect(context!.history).toHaveLength(100)
  expect(context!.history.some(row => row.id === item.id)).toBe(false)
  expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('Older unsent text')
  fireEvent.click(screen.getByTestId('interaction-discard-unsent'))
  await waitFor(() =>
    expect(screen.queryByTestId('interaction-unsent-text')).not.toBeInTheDocument()
  )
})

it.each(['inventory', 'transcript'])(
  'settles a restored native cache from conversation evidence when %s discovery fails',
  async failure => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    first.unmount()
    harness.transcript.mockClear()
    if (failure === 'inventory') harness.list.mockRejectedValue(new Error('Inventory offline'))
    else
      harness.list.mockResolvedValue({
        projects: [],
        chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
        totalTasks: 1,
      })
    view(interactionQuestion, interactionTask, false, new Error('Transcript offline'), false)
    await waitFor(() => expect(context!.loading).toBe(false))
    expect(context!.pending[0]).toMatchObject({ id: item.id, cached: true })
    await act(async () => expect(await context!.respond(context!.pending[0], 'keep')).toBe(false))
    expect(harness.send).not.toHaveBeenCalled()
    const reads = harness.transcript.mock.calls.length
    await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
    await waitFor(() => expect(context!.pending).toHaveLength(0))
    expect(context!.history).toEqual([expect.objectContaining({ id: item.id })])
    expect(harness.transcript).toHaveBeenCalledTimes(reads)
    expect(harness.send).not.toHaveBeenCalled()
  }
)

it.each([true, false])('keeps shared Issue settlement authoritative (cached=%s)', async cached => {
  const item = {
    ...issueHumanInteraction(
      {
        id: 'shared-question',
        project_id: 'project',
        issue_id: 'ISSUE-1',
        root_comment_id: 'root',
        runtime_device_id: interactionTask.address.deviceId,
        runtime_task_id: interactionTask.address.taskId,
        item_id: interactionQuestion.itemId!,
        question: 'Choose scope',
        recipient_user_id: 7,
        status: 'pending',
        version: 1,
        blocks_progress: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      'backend'
    ),
    cached,
  }
  const settle = vi.fn().mockResolvedValue(undefined)
  renderHook(() => useRuntimeInteractionSettlements([item], settle))
  await act(async () => cacheQuestion({ ...interactionQuestion, interactionStatus: 'answered' }))
  expect(settle).not.toHaveBeenCalled()
})
