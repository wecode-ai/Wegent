import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.restoreAllMocks())

async function issueQuestionTask() {
  const { interactionTask } = await import('./runtimeInteractions.fixtures')
  return {
    ...interactionTask,
    address: { ...interactionTask.address, deviceId: 'native-device-alias' },
    task: {
      ...interactionTask.task,
      runtimeHandle: {
        origin: {
          type: 'board_comment',
          cloudProjectId: 'project',
          loopItemId: 'ISSUE-1',
          rootCommentId: 'root',
          projectStore: 'backend',
        },
      },
    },
  }
}

it('retains shared dismissal when only a differently addressed native copy remains', async () => {
  const task = await issueQuestionTask()
  const rendered = view(undefined, task)
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const native = context!.pending[0]
  const question = {
    id: 'shared',
    project_id: 'project',
    issue_id: 'ISSUE-1',
    root_comment_id: 'root',
    runtime_device_id: 'shared-device',
    runtime_task_id: native.task.address.taskId,
    item_id: native.payload.itemId!,
    question: 'Shared decision',
    recipient_user_id: 7,
    status: 'pending',
    version: 1,
    blocks_progress: true,
    created_at: new Date(native.createdAt).toISOString(),
    waiting_since: new Date(Date.now() + 1000).toISOString(),
  }
  const inbox = vi.fn().mockResolvedValue({ items: [question] })
  rendered.rerenderSource({
    ...rendered.taskSource,
    userId: 7,
    services: {
      ...rendered.taskSource.services!,
      issueHumanRequestsApi: {
        inbox,
        list: vi.fn().mockResolvedValue({ items: [] }),
        assign: vi.fn(),
      },
    },
  })
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() =>
    expect(context!.pending.some(item => item.sharedRequest?.id === 'shared')).toBe(true)
  )
  const shared = context!.pending.find(item => item.sharedRequest?.id === 'shared')!
  expect(shared.id).not.toBe(native.id)
  await act(async () => {
    await context!.dismiss(shared)
  })
  inbox.mockResolvedValue({ items: [] })
  await act(async () => {
    await context!.refresh()
  })
  expect(context!.pending.some(item => item.id === native.id)).toBe(false)
  await act(async () => {
    const key = 'wework.interactions:test:1:history'
    localStorage.setItem(key, '[]')
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '[]' }))
    await context!.refresh()
  })
  expect(context!.pending.some(item => item.id === native.id)).toBe(false)
  inbox.mockResolvedValue({
    items: [{ ...question, waiting_since: new Date(Date.now() + 2000).toISOString() }],
  })
  await act(async () => {
    await context!.refresh()
  })
  expect(context!.pending.some(item => item.sharedRequest?.id === 'shared')).toBe(true)
})

it('does not persist dismissal before its history lock is acquired', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  const historyKey = 'wework.interactions:test:1:history'
  const acceptanceKey = `wework.interactions:test:1:accepted:${item.id}`
  let release!: () => void
  harness.locks.set(historyKey, new Promise<void>(resolve => (release = resolve)))
  const request = vi.spyOn(navigator.locks, 'request')
  let completion!: Promise<void>
  await act(async () => {
    completion = context!.dismiss(item)
  })
  expect(request).toHaveBeenCalledWith(historyKey, expect.any(Function))
  expect(localStorage.getItem(acceptanceKey)).toBeNull()
  expect(context!.history).toHaveLength(0)
  expect(context!.pending).toHaveLength(1)
  expect(context!.busy.has(item.id)).toBe(true)

  const setItem = Storage.prototype.setItem
  let historyAtAcceptance: unknown
  const persist = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === acceptanceKey) {
      historyAtAcceptance = JSON.parse(localStorage.getItem(historyKey) || 'null')
    }
    setItem.call(this, key, value)
  })
  await act(async () => {
    release()
    await completion
  })
  expect(persist).toHaveBeenCalledWith(acceptanceKey, JSON.stringify('dismissed'))
  expect(historyAtAcceptance).toEqual([expect.objectContaining({ id: item.id })])
  expect(localStorage.getItem(acceptanceKey)).toBe(JSON.stringify('dismissed'))
  expect(context!.history[0].id).toBe(item.id)
  expect(context!.pending).toHaveLength(0)
  expect(context!.busy.size).toBe(0)
  expect(harness.send).not.toHaveBeenCalled()
})

it('archives project work without inventing a runtime task and retains it after remount', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_794_396_000_000)
  const rendered = view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const entry = {
    id: 'project-issue:local:12:ISSUE-1:handoff',
    source: 'project' as const,
    title: 'Project',
    question: 'Decide',
    originalUrl: 'wework://boards/local/12/issues/ISSUE-1',
    answeredAt: Date.now(),
  }
  await act(async () => {
    await context!.dismiss(entry)
  })
  expect(context!.history).toContainEqual({ ...entry, dismissed: true })
  expect(context!.isDismissed?.(entry.id)).toBe(true)
  rendered.unmount()
  view()
  await waitFor(() => expect(context!.history).toContainEqual({ ...entry, dismissed: true }))
  expect(context!.isDismissed?.(entry.id)).toBe(true)
  expect(harness.send).not.toHaveBeenCalled()
})

it.each([false, true])(
  'locally dismisses a shared question without answering or assigning its Issue (server clock ahead: %s)',
  async clockAhead => {
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const native = context!.pending[0]
    const question = {
      id: 'shared',
      project_id: 'project',
      issue_id: 'ISSUE-1',
      root_comment_id: 'root',
      runtime_device_id: native.task.address.deviceId,
      runtime_task_id: native.task.address.taskId,
      item_id: 'question',
      question: 'Shared decision',
      recipient_user_id: 7,
      responsible_user_id: 7,
      status: 'pending',
      version: 1,
      blocks_progress: true,
      created_at: new Date(native.createdAt).toISOString(),
      ...(clockAhead ? { waiting_since: new Date(Date.now() + 60_000).toISOString() } : {}),
    }
    const inbox = vi.fn().mockResolvedValue({ items: [question] })
    const list = vi.fn().mockResolvedValue({ items: [question] })
    const assign = vi.fn()
    rendered.rerenderSource({
      ...rendered.taskSource,
      userId: 7,
      services: {
        ...rendered.taskSource.services!,
        issueHumanRequestsApi: { inbox, list, assign },
      },
    })
    await act(async () => {
      await context!.refresh()
    })
    await waitFor(() =>
      expect(context!.pending.some(item => item.sharedRequest?.id === 'shared')).toBe(true)
    )
    const shared = context!.pending.find(item => item.sharedRequest?.id === 'shared')!
    await act(async () => {
      await context!.dismiss(shared)
    })
    expect(context!.pending.some(item => item.id === shared.id)).toBe(false)
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending.some(item => item.id === shared.id)).toBe(false)
    expect(context!.history).toContainEqual(expect.objectContaining({ id: shared.id }))
    expect(assign).not.toHaveBeenCalled()
    expect(harness.send).not.toHaveBeenCalled()
  }
)

it('keeps dismissal pending when durable storage fails and allows recovery', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  harness.flushStorage.mockRejectedValue(new Error('Disk unavailable'))
  await act(async () => {
    await expect(context!.dismiss(item)).rejects.toThrow('Disk unavailable')
  })
  expect(context!.pending).toHaveLength(1)
  expect(context!.history).toHaveLength(0)
  expect(context!.busy.size).toBe(0)
  expect(context!.isDismissed?.(item.id)).toBe(false)
  harness.flushStorage.mockResolvedValue(undefined)
  await act(async () => {
    await context!.dismiss(item)
  })
  expect(context!.pending).toHaveLength(0)
  expect(context!.history[0].id).toBe(item.id)
  expect(harness.send).not.toHaveBeenCalled()
})

it('keeps an authoritative pending Issue visible when native handled history exists', async () => {
  const rendered = view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const native = context!.pending[0]
  localStorage.setItem(
    'wework.interactions:test:1:history',
    JSON.stringify([
      {
        id: native.id,
        title: native.task.task.title,
        question: native.question,
        address: native.task.address,
        answeredAt: Date.now(),
      },
    ])
  )
  rendered.unmount()
  const restarted = view()
  const question = {
    id: 'authoritative-pending',
    project_id: 'project',
    issue_id: 'ISSUE-1',
    root_comment_id: 'root',
    runtime_device_id: native.task.address.deviceId,
    runtime_task_id: native.task.address.taskId,
    item_id: native.payload.itemId!,
    question: native.question,
    recipient_user_id: 7,
    status: 'pending',
    version: 1,
    blocks_progress: true,
    created_at: new Date(native.createdAt).toISOString(),
  }
  const inbox = vi.fn().mockResolvedValue({ items: [question] })
  restarted.rerenderSource({
    ...restarted.taskSource,
    userId: 7,
    services: {
      ...restarted.taskSource.services!,
      issueHumanRequestsApi: {
        inbox,
        list: vi.fn().mockResolvedValue({ items: [question] }),
        assign: vi.fn(),
      },
    },
  })
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() =>
    expect(context!.pending.some(item => item.sharedRequest?.id === question.id)).toBe(true)
  )
})

it('does not commit a failed dismissal when the next item in a batch succeeds', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const first = context!.pending[0]
  harness.flushStorage.mockRejectedValueOnce(new Error('First flush failed'))
  await act(async () => {
    await expect(context!.dismiss(first)).rejects.toThrow('First flush failed')
  })
  const second = {
    id: 'project-issue:local:12:ISSUE-2:untracked',
    source: 'project' as const,
    title: 'Project',
    question: 'Another decision',
    originalUrl: 'wework://boards/local/12/issues/ISSUE-2',
    answeredAt: Date.now(),
  }
  await act(async () => {
    await context!.dismiss(second)
  })
  expect(context!.isDismissed?.(first.id)).toBe(false)
  expect(context!.pending.some(item => item.id === first.id)).toBe(true)
  expect(context!.history.map(item => item.id)).toEqual([second.id])
  expect(context!.isDismissed?.(second.id)).toBe(true)
})

it('keeps unarchived work readable when dismissal-marker storage cannot be read', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const read = Storage.prototype.getItem
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
    if (key.includes(':accepted:')) throw new Error('Storage unavailable')
    return read.call(this, key)
  })
  expect(() => context!.isDismissed?.('project-issue:local:12:ISSUE-2:untracked')).not.toThrow()
  expect(context!.isDismissed?.('project-issue:local:12:ISSUE-2:untracked')).toBe(false)
})

it.each([
  'same-question',
  'same-question-updated',
  'later-question',
  'another-issue',
  'returned-question',
  'returned-question-behind-clock',
])('preserves native dismissal across the shared representation: %s', async scenario => {
  const { interactionQuestion, interactionTask } = await import('./runtimeInteractions.fixtures')
  const task = await issueQuestionTask()
  const rendered = view(interactionQuestion, task)
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const native = context!.pending[0]
  await act(async () => {
    await context!.dismiss(native)
  })
  const question = {
    id: 'shared-after-discovery',
    project_id: 'project',
    issue_id: scenario === 'another-issue' ? 'ISSUE-2' : 'ISSUE-1',
    root_comment_id: 'root',
    runtime_device_id: interactionTask.address.deviceId,
    runtime_task_id: native.task.address.taskId,
    item_id: scenario === 'later-question' ? 'later-question' : native.payload.itemId!,
    question: 'Shared question',
    recipient_user_id: 7,
    status: 'pending',
    version: 1,
    blocks_progress: true,
    created_at: new Date(native.createdAt).toISOString(),
    updated_at: new Date(
      scenario === 'same-question-updated'
        ? context!.history[0].answeredAt + 1000
        : native.createdAt
    ).toISOString(),
    ...(scenario.startsWith('returned-question')
      ? {
          waiting_since: new Date(
            scenario === 'returned-question'
              ? context!.history[0].answeredAt + 1000
              : native.createdAt + 1000
          ).toISOString(),
        }
      : {}),
  }
  const inbox = vi.fn().mockResolvedValue({ items: [question] })
  rendered.rerenderSource({
    ...rendered.taskSource,
    userId: 7,
    services: {
      ...rendered.taskSource.services!,
      issueHumanRequestsApi: {
        inbox,
        list: vi.fn().mockResolvedValue({ items: [] }),
        assign: vi.fn(),
      },
    },
  })
  await act(async () => {
    await context!.refresh()
  })
  await waitFor(() => expect(inbox).toHaveBeenCalled())
  expect(context!.pending.some(item => item.sharedRequest?.id === question.id)).toBe(
    !scenario.startsWith('same-question')
  )
  if (scenario.startsWith('same-question') || scenario.startsWith('returned-question')) {
    rendered.unmount()
    localStorage.setItem('wework.interactions:test:1:history', '[]')
    const restarted = view(interactionQuestion, task)
    restarted.rerenderSource({
      ...restarted.taskSource,
      userId: 7,
      services: {
        ...restarted.taskSource.services!,
        issueHumanRequestsApi: {
          inbox,
          list: vi.fn().mockResolvedValue({ items: [] }),
          assign: vi.fn(),
        },
      },
    })
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending.some(item => item.sharedRequest?.id === question.id)).toBe(
      scenario.startsWith('returned-question')
    )
  }
})
