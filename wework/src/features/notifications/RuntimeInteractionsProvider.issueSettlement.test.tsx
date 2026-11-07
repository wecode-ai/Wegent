// Register provider mocks before importing modules that consume them.
import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { interactionQuestion } from './runtimeInteractions.fixtures'

it.each(['resolved', 'transferred', 'revoked'])(
  'reconciles only an exactly resolved Issue question, not %s removal',
  async state => {
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const native = context!.pending[0]
    const question = {
      id: 'canonical-question',
      project_id: 'project',
      issue_id: 'ISSUE-1',
      root_comment_id: 'root',
      runtime_device_id: native.task.address.deviceId,
      runtime_task_id: native.task.address.taskId,
      item_id: interactionQuestion.itemId,
      question: native.question,
      recipient_user_id: 7,
      responsible_user_id: 7,
      status: 'pending',
      version: 1,
      blocks_progress: true,
      created_at: new Date(native.createdAt).toISOString(),
    }
    const inbox = vi.fn().mockResolvedValue({ items: [question] })
    const list = vi.fn().mockResolvedValue({ items: [question] })
    rendered.rerenderSource({
      ...rendered.taskSource,
      userId: 7,
      services: {
        ...rendered.taskSource.services!,
        issueHumanRequestsApi: { inbox, list, assign: vi.fn() },
      },
    })
    await act(async () => {
      await context!.refresh()
    })
    await waitFor(() => expect(context!.pending[0].sharedRequest?.id).toBe('canonical-question'))

    // The durable answer commits before the original native question can be re-read.
    inbox.mockResolvedValue({ items: [] })
    if (state === 'revoked') list.mockRejectedValue(new Error('Access revoked'))
    else
      list.mockResolvedValue({
        items: [
          {
            ...question,
            status: state === 'resolved' ? 'resolved' : 'pending',
            recipient_user_id: 9,
            answer_message_id: state === 'resolved' ? 'answer' : undefined,
          },
        ],
      })
    harness.transcript.mockRejectedValue(new Error('Native transcript unavailable'))
    await act(async () => {
      await context!.refresh()
    })

    await waitFor(() => expect(context!.pending).toHaveLength(state === 'resolved' ? 0 : 1))
    expect(context!.history.some(item => item.id === native.id)).toBe(state === 'resolved')
    expect(harness.send).not.toHaveBeenCalled()
  }
)
