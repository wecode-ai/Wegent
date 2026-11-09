// Register provider mocks before importing modules that consume them.
import { context, harness, probe, view } from './runtimeInteractionsProvider.fixtures'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IssueHumanRequest } from '@wegent/collaboration'
import { issueHumanInteraction } from './issueHumanInteractions'
import { pendingInteractionCache, saveInteractionState } from './interactionStorage'
import { interactionQuestion, interactionTask } from './runtimeInteractions.fixtures'
import { NotificationTaskContext, type TaskSource } from './NotificationTaskSourceContext'
import { RuntimeInteractionsProvider } from './RuntimeInteractionsProvider'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

it('does not rediscover a cached shared question as a second native task source', async () => {
  const question: IssueHumanRequest = {
    id: 'canonical-question',
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
    blocks_progress: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  saveInteractionState(
    'wework.interactions:test:1:pending',
    pendingInteractionCache([issueHumanInteraction(question, 'backend')])
  )
  const rendered = view()
  const inbox = vi.fn().mockResolvedValue({ items: [] })
  const list = vi.fn().mockResolvedValue({ items: [] })
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
  await waitFor(() => expect(context!.loading).toBe(false))

  expect(context!.pending).toHaveLength(1)
  expect(new Set(context!.pending.map(item => item.id)).size).toBe(context!.pending.length)
  expect(context!.pending[0].task.key).toBe(interactionTask.key)
  expect(
    harness.transcript.mock.calls.every(
      ([address]) => address.taskId === interactionTask.address.taskId
    )
  ).toBe(true)
  expect(screen.getAllByTestId('interaction-list-item')).toHaveLength(1)
  inbox.mockResolvedValue({ items: [question] })
  list.mockResolvedValue({ items: [question] })
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() => expect(context!.pending[0].sharedRequest?.id).toBe(question.id))
  expect(screen.getAllByTestId('interaction-list-item')).toHaveLength(1)
  inbox.mockResolvedValue({ items: [] })
  list.mockResolvedValue({
    items: [{ ...question, status: 'resolved', answer_message_id: 'answer' }],
  })
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() => expect(context!.pending).toHaveLength(0))
  await waitFor(() => expect(context!.history).toHaveLength(1))
  expect(screen.queryAllByTestId('interaction-list-item')).toHaveLength(0)
  fireEvent.click(screen.getByTestId('interactions-history'))
  expect(screen.getAllByTestId('interaction-list-item')).toHaveLength(1)
  expect(screen.getByTestId('interaction-list-time').getAttribute('datetime')).toBe(
    screen.getByTestId('interaction-detail-time').getAttribute('datetime')
  )
})

it('keeps an offline cached shared question in its inbox without probing its private Runtime', async () => {
  const question: IssueHumanRequest = {
    id: 'private-question',
    project_id: 'project',
    issue_id: 'ISSUE-1',
    root_comment_id: 'root',
    runtime_device_id: 'another-owner-private-device',
    runtime_task_id: 'private-task',
    item_id: 'business-question',
    question: 'Choose scope',
    recipient_user_id: 7,
    status: 'pending',
    version: 1,
    blocks_progress: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  saveInteractionState(
    'wework.interactions:test:1:pending',
    pendingInteractionCache([issueHumanInteraction(question, 'backend')])
  )
  const taskSource: TaskSource = {
    items: [],
    userId: 7,
    services: {
      runtimeWorkApi: { getRuntimeTranscript: harness.transcript, listRuntimeWork: harness.list },
      issueHumanRequestsApi: {
        inbox: vi.fn().mockRejectedValue(new Error('Cloud offline')),
        list: vi.fn(),
        assign: vi.fn(),
      },
    } as unknown as WorkbenchServices,
    unreadTaskKeys: new Set(),
    markRuntimeTaskRead: harness.read,
    refresh: harness.refresh,
  }
  render(
    <NotificationTaskContext.Provider value={{ taskSource, registerTaskSource: () => {} }}>
      <RuntimeInteractionsProvider accountKey="test:1">{probe}</RuntimeInteractionsProvider>
    </NotificationTaskContext.Provider>
  )
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  expect(context!.pending[0].sharedRequest?.id).toBe(question.id)
  expect(context!.pending[0].cached).toBe(true)
  expect(harness.transcript).not.toHaveBeenCalled()
})
