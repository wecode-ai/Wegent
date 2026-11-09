import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
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
