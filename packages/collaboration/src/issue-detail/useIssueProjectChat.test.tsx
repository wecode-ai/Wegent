// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import { useIssueProjectChat } from './useIssueProjectChat'

function createMessage(overrides: Partial<ProjectChatMessage>): ProjectChatMessage {
  return {
    messageId: 'comment',
    projectId: 'project-1',
    taskId: 'issue-1',
    sequenceNumber: 1,
    sender: { type: 'user', id: '42', name: 'User' },
    type: 'text',
    content: '',
    metadata: {},
    status: 'completed',
    createdAt: '2026-09-25T00:00:00Z',
    updatedAt: '2026-09-25T00:00:00Z',
    ...overrides,
  }
}

it.each(['after failure', 'during failure'])(
  'restores a failed initial subscription when reconnect occurs %s',
  async timing => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    let reconnect!: () => void
    let rejectInitial!: (error: Error) => void
    const unsubscribe = vi.fn()
    const stopReconnect = vi.fn()
    const client = {
      onReconnect: vi.fn(callback => {
        reconnect = callback
        return stopReconnect
      }),
      subscribe: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectInitial = reject
            })
        )
        .mockResolvedValue({
          snapshot: { messages: [], currentUserId: '42' },
          unsubscribe,
        }),
    } as unknown as ProjectChatClient
    let current!: ReturnType<typeof useIssueProjectChat>
    function Harness() {
      current = useIssueProjectChat(client, 'project-1', 'issue-1')
      return <div>{current.error ?? current.currentUserId}</div>
    }
    try {
      await act(async () => root.render(<Harness />))
      await act(async () => {
        if (timing === 'during failure') reconnect()
        rejectInitial(new Error('websocket error'))
      })
      if (timing === 'after failure') {
        expect(container.textContent).toBe('websocket error')
        await act(async () => reconnect())
      }
      expect(current.error).toBeNull()
      expect(current.loading).toBe(false)
      expect(container.textContent).toBe('42')
      expect(client.subscribe).toHaveBeenCalledTimes(2)
      await act(async () => reconnect())
      expect(client.subscribe).toHaveBeenCalledTimes(2)
    } finally {
      act(() => root.unmount())
      expect(stopReconnect).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      reconnect()
      expect(client.subscribe).toHaveBeenCalledTimes(2)
    }
  }
)

it('does not merge a late comment or runtime response into another Issue', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  let resolveSend!: (message: ProjectChatMessage) => void
  const client = {
    subscribe: vi.fn().mockResolvedValue({ snapshot: { messages: [] }, unsubscribe: vi.fn() }),
    send: vi.fn(
      () =>
        new Promise<ProjectChatMessage>(resolve => {
          resolveSend = resolve
        })
    ),
  } as unknown as ProjectChatClient
  let current!: ReturnType<typeof useIssueProjectChat>
  function Harness({ issueId }: { issueId: string }) {
    current = useIssueProjectChat(client, 'project-1', issueId)
    return <div>{current.messages.map(message => message.content).join(',')}</div>
  }
  try {
    await act(async () => root.render(<Harness issueId="issue-1" />))
    const previousMerge = current.merge
    const pending = current.send('Old comment')
    await act(async () => root.render(<Harness issueId="issue-2" />))
    const oldMessage = createMessage({
      messageId: 'old',
      taskId: 'issue-1',
      content: 'Old comment',
      sequenceNumber: 1,
    })
    await act(async () => {
      resolveSend(oldMessage)
      await pending
      previousMerge([oldMessage])
    })
    expect(container.textContent).toBe('')
    await act(async () =>
      current.merge([
        {
          ...oldMessage,
          messageId: 'new',
          taskId: 'issue-2',
          content: 'New comment',
        },
      ])
    )
    expect(container.textContent).toBe('New comment')
  } finally {
    act(() => root.unmount())
  }
})

it('reloads the canonical activity snapshot when the Issue revision changes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const first = createMessage({
    messageId: 'first',
    taskId: 'issue-1',
    content: 'First activity',
    sequenceNumber: 1,
    updatedAt: '2026-09-25T00:00:00Z',
  })
  const managerComment = {
    ...first,
    messageId: 'manager-comment',
    content: '负责人已综合证据，将 Issue 提交待确认。',
    sequenceNumber: 2,
    updatedAt: '2026-09-25T00:00:01Z',
  }
  const unsubscribe = vi.fn()
  const client = {
    subscribe: vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: { messages: [first] },
        unsubscribe,
      })
      .mockResolvedValueOnce({
        snapshot: { messages: [first, managerComment] },
        unsubscribe,
      }),
  } as unknown as ProjectChatClient
  function Harness({ revision }: { revision: number }) {
    const chat = useIssueProjectChat(client, 'project-1', 'issue-1', revision)
    return <div>{chat.messages.map(message => message.content).join(',')}</div>
  }
  try {
    await act(async () => root.render(<Harness revision={1} />))
    expect(container.textContent).toBe('First activity')

    await act(async () => root.render(<Harness revision={2} />))

    expect(client.subscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('负责人已综合证据，将 Issue 提交待确认。')
  } finally {
    act(() => root.unmount())
  }
})

it('keeps the activity and reply draft mounted while an Issue revision refreshes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const message = createMessage({
    messageId: 'comment',
    taskId: 'issue-1',
    content: 'Persisted comment',
    sequenceNumber: 1,
    updatedAt: '2026-10-13T00:00:00Z',
  })
  let finishRefresh!: (subscription: unknown) => void
  const client = {
    subscribe: vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: { messages: [message] },
        unsubscribe: vi.fn(),
      })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishRefresh = resolve
          })
      ),
  } as unknown as ProjectChatClient
  function Harness({ revision }: { revision: number }) {
    const chat = useIssueProjectChat(client, 'project-1', 'issue-1', revision)
    return (
      <div>
        {chat.messages.map(item => (
          <textarea key={item.messageId} />
        ))}
      </div>
    )
  }
  try {
    await act(async () => root.render(<Harness revision={2} />))
    const composer = container.querySelector('textarea')!
    composer.value = 'Unsent reply'

    await act(async () => root.render(<Harness revision={3} />))

    expect(container.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('Unsent reply')
    await act(async () =>
      finishRefresh({
        snapshot: { messages: [message] },
        unsubscribe: vi.fn(),
      })
    )
    expect(container.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('Unsent reply')
  } finally {
    act(() => root.unmount())
  }
})

it('clears a subscription error when a revision refresh succeeds', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const client = {
    subscribe: vi
      .fn()
      .mockRejectedValueOnce(new Error('Subscription failed'))
      .mockResolvedValueOnce({
        snapshot: { messages: [] },
        unsubscribe: vi.fn(),
      }),
  } as unknown as ProjectChatClient
  let current!: ReturnType<typeof useIssueProjectChat>
  function Harness({ revision }: { revision: number }) {
    current = useIssueProjectChat(client, 'project-1', 'issue-1', revision)
    return null
  }
  try {
    await act(async () => root.render(<Harness revision={1} />))
    expect(current.error).toBe('Subscription failed')

    await act(async () => root.render(<Harness revision={2} />))

    expect(current.error).toBeNull()
    expect(current.loading).toBe(false)
  } finally {
    act(() => root.unmount())
  }
})

it('preserves live external replies between the refresh snapshot read and room join', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const progress = createMessage({
    sender: { type: 'agent', id: 'worker', name: 'Worker' },
    status: 'streaming',
    metadata: { externalInvocation: true, externalReplyRevision: '2' },
  })
  const appended = {
    ...progress,
    content: 'Worker completed the check.',
    metadata: { ...progress.metadata, externalReplyRevision: '3' },
  }
  const streaming = createMessage({
    messageId: 'runtime',
    sequenceNumber: 2,
    sender: { type: 'agent', id: 'runtime', name: 'Runtime' },
    status: 'streaming',
    content: 'First chunk',
  })
  const delta: ProjectChatMessage = {
    ...streaming,
    type: 'agent_chunk',
    content: ' and next',
    metadata: { contentMode: 'delta' },
    updatedAt: '2026-09-25T00:00:01Z',
  }
  const refreshRead = Promise.withResolvers<void>()
  const finishRefresh = Promise.withResolvers<void>()
  const joined = new Set<(message: ProjectChatMessage) => void>()
  const listeners = new Set<(message: ProjectChatMessage) => void>()
  const chunkListeners = new Set<(message: ProjectChatMessage) => void>()
  let subscriptions = 0
  function emit(message: ProjectChatMessage) {
    if (joined.size) listeners.forEach(receive => receive(message))
  }
  const client = {
    subscribe: vi.fn(async (...args: Parameters<ProjectChatClient['subscribe']>) => {
      const receive = args[3]
      const receiveChunk = args[4]!
      listeners.add(receive)
      chunkListeners.add(receiveChunk)
      const snapshot = {
        messages: [progress, streaming],
        latestSequence: 2,
        currentUserId: '42',
      }
      if (++subscriptions > 1) {
        // The Backend has read the persisted progress but has not yet joined the room.
        refreshRead.resolve()
        await finishRefresh.promise
      }
      joined.add(receive)
      return {
        snapshot,
        unsubscribe: () => {
          listeners.delete(receive)
          chunkListeners.delete(receiveChunk)
          joined.delete(receive)
        },
      }
    }),
  }
  function Harness({ revision }: { revision: number }) {
    const chat = useIssueProjectChat(
      client as unknown as ProjectChatClient,
      'project-1',
      'issue-1',
      revision
    )
    return <div>{chat.messages.map(message => message.content).join(',')}</div>
  }
  try {
    await act(async () => root.render(<Harness revision={2} />))
    expect(joined.size).toBe(1)
    act(() => root.render(<Harness revision={3} />))
    await refreshRead.promise
    // A fast Worker updates this message after the snapshot read. The established
    // subscription must carry the live event until the new join is acknowledged.
    act(() => {
      emit(appended)
      if (joined.size) chunkListeners.forEach(receive => receive(delta))
    })
    expect(container.textContent).toBe(`${progress.content},${streaming.content}`)
    await act(async () => finishRefresh.resolve())
    expect(container.textContent).toBe(`${appended.content},${streaming.content}${delta.content}`)
    expect(joined.size).toBe(1)
    expect(listeners.size).toBe(1)
  } finally {
    finishRefresh.resolve()
    await act(async () => root.unmount())
  }
  expect(joined.size).toBe(0)
  expect(listeners.size).toBe(0)
  expect(chunkListeners.size).toBe(0)
})

it('releases the retained room and discards buffered replies when a newer refresh is denied', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const progress = createMessage({ content: 'Previously authorized content' })
  const denied = new Error('Access denied')
  const invalidatesSnapshot = (error: unknown) => error === denied
  type Subscription = Awaited<ReturnType<ProjectChatClient['subscribe']>>
  const olderRefresh = Promise.withResolvers<Subscription>()
  const latestRefresh = Promise.withResolvers<Subscription>()
  const unsubscribe = vi.fn()
  const unsubscribeOlder = vi.fn()
  let receiveLatest!: (message: ProjectChatMessage) => void
  const subscription = (messages: ProjectChatMessage[], unsubscribe: () => void) => ({
    snapshot: { messages, latestSequence: 1, currentUserId: '42' },
    unsubscribe,
  })
  const client = {
    subscribe: vi
      .fn<ProjectChatClient['subscribe']>()
      .mockResolvedValueOnce(subscription([progress], unsubscribe))
      .mockImplementationOnce(() => olderRefresh.promise)
      .mockImplementationOnce((_project, _issue, _after, receive) => {
        receiveLatest = receive
        return latestRefresh.promise
      }),
  }
  function Harness({ revision }: { revision: number }) {
    const chat = useIssueProjectChat(
      client as unknown as ProjectChatClient,
      'project-1',
      'issue-1',
      revision,
      invalidatesSnapshot
    )
    return <div>{chat.messages.map(message => message.content).join(',')}</div>
  }
  try {
    await act(async () => root.render(<Harness revision={1} />))
    expect(container.textContent).toBe(progress.content)
    await act(async () => root.render(<Harness revision={2} />))
    await act(async () => root.render(<Harness revision={3} />))
    // Both pending attempts must keep the original room lease alive.
    expect(unsubscribe).not.toHaveBeenCalled()
    act(() => receiveLatest({ ...progress, content: 'Unconfirmed reply' }))
    expect(container.textContent).toBe(progress.content)
    await act(async () => latestRefresh.reject(denied))
    expect(container.textContent).toBe('')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await act(async () => olderRefresh.resolve(subscription([progress], unsubscribeOlder)))
    expect(unsubscribeOlder).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')
  } finally {
    olderRefresh.resolve(subscription([], unsubscribeOlder))
    latestRefresh.reject(denied)
    await act(async () => root.unmount())
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(unsubscribeOlder).toHaveBeenCalledTimes(1)
})
