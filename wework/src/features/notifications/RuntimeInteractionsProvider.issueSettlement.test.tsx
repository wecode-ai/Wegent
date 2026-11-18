// Register provider mocks before importing modules that consume them.
import { context, harness, probe, view } from './runtimeInteractionsProvider.fixtures'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { interactionQuestion, interactionTranscript } from './runtimeInteractions.fixtures'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { issueHumanInteraction, issueQuestionIdentity } from './issueHumanInteractions'
import { interactionHistoryEntry } from './interactionArchive'
import { pendingInteractionCache, saveInteractionState } from './interactionStorage'
import { NotificationTaskContext, type TaskSource } from './NotificationTaskSourceContext'
import { RuntimeInteractionsProvider } from './RuntimeInteractionsProvider'

it.each([
  'resolved',
  'cancelled',
  'transferred',
  'revoked',
  'resolved-offline-restart',
  'resolved-offline-alias-restart',
  'resolved-offline-other-issue-restart',
  'resolved-offline-other-store-restart',
  'resolved-late-response-other-issue',
  'resolved-late-response-other-store',
  'resolved-late-response-shared-other-issue',
  'resolved-late-response-shared-other-store',
])('reconciles only an exactly handled Issue question across %s removal', async state => {
  const settled = state.startsWith('resolved') || state === 'cancelled'
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
  const projectSend = vi.fn()
  const executeTaskComment = vi.fn()
  const projectChatClient = {
    send: projectSend,
    executeTaskComment,
  } as unknown as WorkbenchServices['projectChatClient']
  rendered.rerenderSource({
    ...rendered.taskSource,
    userId: 7,
    services: {
      ...rendered.taskSource.services!,
      issueHumanRequestsApi: { inbox, list, assign: vi.fn() },
      projectChatClient,
    },
  })
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() => expect(context!.pending[0].sharedRequest?.id).toBe('canonical-question'))
  const sharedSnapshot = context!.pending[0]

  // The durable answer commits before the original native question can be re-read.
  inbox.mockResolvedValue({ items: [] })
  if (state === 'revoked') list.mockRejectedValue(new Error('Access revoked'))
  else
    list.mockResolvedValue({
      items: [
        {
          ...question,
          status: state === 'cancelled' ? 'cancelled' : settled ? 'resolved' : 'pending',
          recipient_user_id: 9,
          answer_message_id: state.startsWith('resolved') ? 'answer' : undefined,
        },
      ],
    })
  harness.transcript.mockRejectedValue(new Error('Native transcript unavailable'))
  await act(async () => {
    await context!.refresh()
  })

  await waitFor(() => expect(context!.pending).toHaveLength(settled ? 0 : 1))
  expect(context!.history.some(item => item.id === native.id)).toBe(settled)
  expect(harness.send).not.toHaveBeenCalled()
  if (state.includes('late-response')) {
    await act(async () => {
      const snapshot = state.includes('shared') ? sharedSnapshot : native
      expect(await context!.respond(snapshot, 'Late duplicate')).toBe(false)
      const overriddenSend = vi.fn().mockResolvedValue(true)
      expect(await context!.respond(snapshot, 'Late duplicate', { send: overriddenSend })).toBe(
        false
      )
      expect(overriddenSend).not.toHaveBeenCalled()
    })
    expect(harness.send).not.toHaveBeenCalled()
    expect(projectSend).not.toHaveBeenCalled()
    expect(executeTaskComment).not.toHaveBeenCalled()
    list.mockResolvedValue({ items: [] })
    harness.transcript.mockResolvedValue(interactionTranscript())
    const origin = {
      type: 'board_comment' as const,
      cloudProjectId: 'project',
      loopItemId: state.includes('other-issue') ? 'OTHER-ISSUE' : 'ISSUE-1',
      rootCommentId: 'root',
      ...(state.includes('other-store') ? { projectStore: 'local' as const } : {}),
    }
    rendered.rerenderSource({
      ...rendered.taskSource,
      userId: 7,
      items: [{ ...native.task, task: { ...native.task.task, runtimeHandle: { origin } } }],
      services: {
        ...rendered.taskSource.services!,
        issueHumanRequestsApi: { inbox, list, assign: vi.fn() },
      },
    })
    await act(async () => {
      await context!.refresh()
    })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    expect(context!.pending[0].id).toBe(native.id)
    expect(context!.pending[0].project?.issueId).toBe(origin.loopItemId)
    expect(context!.pending[0].project?.store).toBe(origin.projectStore ?? 'backend')
  }
  if (state.endsWith('restart')) {
    rendered.unmount()
    const restarted =
      state !== 'resolved-offline-restart'
        ? view(interactionQuestion, {
            ...native.task,
            address: {
              ...native.task.address,
              deviceId: state.includes('alias')
                ? 'device-route-alias'
                : native.task.address.deviceId,
            },
            task: {
              ...native.task.task,
              runtimeHandle: {
                origin: {
                  type: 'board_comment',
                  cloudProjectId: 'project',
                  loopItemId: state.includes('other-issue') ? 'OTHER-ISSUE' : 'ISSUE-1',
                  rootCommentId: 'root',
                  ...(state.includes('other-store') ? { projectStore: 'local' as const } : {}),
                },
              },
            },
          })
        : view()
    inbox.mockRejectedValue(new Error('Cloud unavailable'))
    list.mockRejectedValue(new Error('Cloud unavailable'))
    restarted.rerenderSource({
      ...restarted.taskSource,
      userId: 7,
      services: {
        ...restarted.taskSource.services!,
        issueHumanRequestsApi: { inbox, list, assign: vi.fn() },
      },
    })
    await act(async () => {
      await context!.refresh()
    })
    expect(harness.transcript).toHaveBeenCalled()
    await waitFor(() => expect(context!.pending).toHaveLength(state.includes('other-') ? 1 : 0))
    expect(context!.history.some(item => item.id === native.id)).toBe(true)
  }
})

it.each(['local', 'backend'] as const)(
  'does not revive a stale cached %s question after its settlement was persisted',
  async store => {
    const { interactionTask } = await import('./runtimeInteractions.fixtures')
    const shared = issueHumanInteraction(
      {
        id: 'cached-settled',
        project_id: 'project',
        issue_id: 'ISSUE-1',
        root_comment_id: 'root',
        runtime_device_id: interactionTask.address.deviceId,
        runtime_task_id: interactionTask.address.taskId,
        item_id: interactionQuestion.itemId!,
        question: 'Already handled',
        recipient_user_id: 7,
        recipient_name: 'Me',
        status: 'pending',
        version: 1,
        blocks_progress: false,
        created_at: '2026-11-10T00:00:00Z',
        updated_at: '2026-11-10T00:00:00Z',
      },
      store
    )
    saveInteractionState('wework.interactions:test:1:history', [
      {
        ...interactionHistoryEntry(shared, Date.now()),
        resolvedIssueQuestion: {
          questionIdentity: issueQuestionIdentity(shared)!,
          nativeInteractionId: shared.id,
        },
      },
    ])
    // Pending cache and durable history can come from different flushes before shutdown.
    saveInteractionState('wework.interactions:test:1:pending', pendingInteractionCache([shared]))
    const inbox = vi.fn().mockRejectedValue(new Error('Offline'))
    const api = { inbox, list: vi.fn(), assign: vi.fn() }
    const taskSource: TaskSource = {
      items: [],
      userId: 7,
      services: {
        [store === 'local' ? 'localIssueHumanRequestsApi' : 'issueHumanRequestsApi']: api,
      } as unknown as WorkbenchServices,
      unreadTaskKeys: new Set(),
      markRuntimeTaskRead: vi.fn(),
    }
    render(
      <NotificationTaskContext.Provider value={{ taskSource }}>
        <RuntimeInteractionsProvider accountKey="test:1">{probe}</RuntimeInteractionsProvider>
      </NotificationTaskContext.Provider>
    )
    await waitFor(() => expect(context!.errors[`issue:${store}`]).toBe('Offline'))
    await act(async () => context!.refresh())
    expect(context!.pending.some(item => item.sharedRequest?.id === 'cached-settled')).toBe(false)
    expect(context!.history.some(item => item.id === shared.id)).toBe(true)

    // A newly validated inbox entry remains authoritative over cached history.
    inbox.mockResolvedValue({ items: [shared.sharedRequest!] })
    await act(async () => context!.refresh())
    expect(context!.pending.some(item => item.sharedRequest?.id === 'cached-settled')).toBe(true)
  }
)
