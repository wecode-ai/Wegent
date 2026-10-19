// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import { useIssueProjectChat } from './useIssueProjectChat'

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
    const oldMessage = {
      messageId: 'old',
      taskId: 'issue-1',
      content: 'Old comment',
      sequenceNumber: 1,
    } as ProjectChatMessage
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
  const first = {
    messageId: 'first',
    taskId: 'issue-1',
    content: 'First activity',
    sequenceNumber: 1,
    updatedAt: '2026-09-25T00:00:00Z',
  } as ProjectChatMessage
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
  const message = {
    messageId: 'comment',
    taskId: 'issue-1',
    content: 'Persisted comment',
    sequenceNumber: 1,
    updatedAt: '2026-10-13T00:00:00Z',
  } as ProjectChatMessage
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
