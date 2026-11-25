// Register provider mocks before importing modules that consume them.
import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TaskSource } from './NotificationTaskSourceContext'
import {
  cacheNotificationPreferences,
  defaultNotificationPreferences,
} from './notificationPreferences'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'
import { canReplyToInteraction } from './runtimeInteractions'
import { weworkInteractionScheme } from './scheme'

const remoteTask = {
  ...interactionTask,
  key: 'remote\0remote-review',
  address: { ...interactionTask.address, deviceId: 'remote', taskId: 'remote-review' },
  task: { ...interactionTask.task, taskId: 'remote-review', title: 'Remote order review' },
  workspace: { ...interactionTask.workspace, deviceId: 'remote' },
}

async function discoverQuestions(focused: boolean) {
  cacheNotificationPreferences('test:1', {
    ...defaultNotificationPreferences,
    tasks: { in_app: true, system: true, im: null },
  })
  harness.desktop = true
  harness.focused = focused
  harness.host.mockImplementation(async method =>
    method === 'notification.pendingReplies' ? [] : undefined
  )
  const rendered = view(interactionQuestion, interactionTask, false, undefined, false)
  await waitFor(() => expect(harness.list).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(context!.loading).toBe(false))
  harness.list.mockImplementation(async ({ deviceId }) => {
    const task = deviceId === remoteTask.address.deviceId ? remoteTask : interactionTask
    return {
      projects: [],
      chats: [{ ...task.workspace, deviceId, tasks: [task.task] }],
      totalTasks: 1,
    }
  })
  harness.transcript.mockImplementation(async request => {
    const remote = request.taskId === remoteTask.address.taskId
    return interactionTranscript(
      {
        ...interactionQuestion,
        itemId: remote ? 'remote-choice' : 'local-choice',
        questions: [
          {
            ...interactionQuestion.questions![0],
            question: remote ? 'Remote question only' : 'Local question only',
          },
        ],
      },
      remote ? 'turn-remote' : 'turn-local'
    )
  })
  rendered.rerenderSource({
    ...rendered.taskSource,
    devices: [
      { device_id: interactionTask.address.deviceId, status: 'online' },
      { device_id: remoteTask.address.deviceId, status: 'online' },
    ] as TaskSource['devices'],
  })
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() => expect(context!.pending).toHaveLength(2))
  expect(rendered.taskSource.items).toEqual([])
  expect(new Set(context!.pending.map(item => item.task.address.deviceId))).toEqual(
    new Set([interactionTask.address.deviceId, remoteTask.address.deviceId])
  )
  expect(harness.list).toHaveBeenCalledWith({
    pendingOnly: true,
    preferCached: true,
    deviceId: remoteTask.address.deviceId,
  })
}

describe('cross-device human input', () => {
  it('keeps the visible state stable when background discovery finds no changes', async () => {
    vi.useFakeTimers()
    try {
      const rendered = view(interactionQuestion, interactionTask, false, undefined, false)
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(context!.loading).toBe(false)
      const discovered = context
      const reads = harness.list.mock.calls.length

      await act(() => vi.advanceTimersByTimeAsync(5_000))

      expect(harness.list.mock.calls.length).toBeGreaterThan(reads)
      expect(context).toBe(discovered)

      rendered.rerenderSource({
        ...rendered.taskSource,
        items: [
          {
            ...interactionTask,
            task: {
              ...interactionTask.task,
              interactionStatus: undefined,
              updatedAt: new Date().toISOString(),
            },
          },
        ],
      })
      await act(() => vi.advanceTimersByTimeAsync(0))

      expect(context).toBe(discovered)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows in-app reminders for local and remote questions absent from the sidebar', async () => {
    await discoverQuestions(true)
    const questions = new Set<string>()
    for (let index = 0; index < 2; index++) {
      await waitFor(() => expect(context!.notice).not.toBeNull())
      questions.add(context!.notice!.question)
      act(() => context!.dismissNotice())
    }
    expect(questions).toEqual(new Set(['Local question only', 'Remote question only']))
    expect(context!.notice).toBeNull()
    expect(context!.pending).toHaveLength(2)
    expect(harness.host.mock.calls.filter(([method]) => method === 'notification.show')).toEqual([])
  })

  it('delivers both system reminders and routes a remote answer to its original task', async () => {
    await discoverQuestions(false)
    const notifications = () =>
      harness.host.mock.calls.filter(([method]) => method === 'notification.show')
    await waitFor(() => expect(notifications()).toHaveLength(2))
    const remote = context!.pending.find(item => item.task.address.deviceId === 'remote')!
    expect(notifications().map(([, payload]) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: interactionTask.task.title,
          body: 'Local question only',
        }),
        expect.objectContaining({
          title: remoteTask.task.title,
          body: 'Remote question only',
          url: weworkInteractionScheme(remote.task.address, remote.requestKey),
        }),
      ])
    )
    expect(canReplyToInteraction(remote)).toBe(true)
    harness.transcript.mockClear()
    await act(async () => {
      expect(await context!.respond(remote, 'keep')).toBe(true)
    })
    expect(harness.transcript).toHaveBeenCalledWith(expect.objectContaining(remote.task.address))
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({ address: remote.task.address })
    )
    expect(harness.guide).not.toHaveBeenCalled()
    expect(context!.pending.map(item => item.task.address.deviceId)).toEqual(['device'])
    expect(context!.history).toEqual([
      expect.objectContaining({ id: remote.id, address: remote.task.address }),
    ])
  })
})
