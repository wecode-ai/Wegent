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

it('retains group messages received while the initial history ACK is pending', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  let receive!: (message: ProjectChatMessage) => void
  let finish!: (value: unknown) => void
  const client = {
    subscribe: vi.fn().mockImplementation((_group, _thread, _after, onMessage) => {
      receive = onMessage
      return new Promise(resolve => {
        finish = resolve
      })
    }),
  } as unknown as ProjectChatClient
  let current!: ReturnType<typeof useIssueProjectChat>
  function Harness() {
    current = useIssueProjectChat(
      client,
      'project-1',
      'issue-1',
      0,
      undefined,
      undefined,
      'chat_group'
    )
    return null
  }
  const before = createMessage({ messageId: 'before', sequenceNumber: 1 })
  const during = createMessage({ messageId: 'during', sequenceNumber: 2 })
  try {
    await act(async () => root.render(<Harness />))
    act(() => {
      receive(before)
      receive(during)
    })
    await act(async () =>
      finish({
        snapshot: {
          messages: [before],
          currentUserId: '42',
          latestSequence: 1,
        },
        unsubscribe: vi.fn(),
      })
    )
    expect(current.messages.map(message => message.messageId)).toEqual(['before', 'during'])
  } finally {
    act(() => root.unmount())
  }
})

it('retains a streaming chunk received before a history ACK without restoring the old window', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  let chunk!: (message: ProjectChatMessage) => void
  let finish!: (value: unknown) => void
  const client = {
    subscribe: vi.fn().mockImplementation((_group, _thread, _after, _message, onChunk) => {
      chunk = onChunk
      return new Promise(resolve => {
        finish = resolve
      })
    }),
  } as unknown as ProjectChatClient
  let current!: ReturnType<typeof useIssueProjectChat>
  function Harness() {
    current = useIssueProjectChat(
      client,
      'project-1',
      'issue-1',
      0,
      undefined,
      undefined,
      'chat_group'
    )
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    act(() =>
      chunk(
        createMessage({
          messageId: 'stream',
          sequenceNumber: 2,
          content: 'new reply',
          status: 'streaming',
          metadata: { contentMode: 'snapshot' },
        })
      )
    )
    await act(async () =>
      finish({
        snapshot: {
          messages: [createMessage({ messageId: 'before', sequenceNumber: 1 })],
        },
        unsubscribe: vi.fn(),
      })
    )
    expect(current.messages.map(message => message.messageId)).toEqual(['before', 'stream'])
    expect(current.messages[1]?.content).toBe('new reply')
  } finally {
    act(() => root.unmount())
  }
})

it.each(['latest', 'history'] as const)(
  'keeps %s window boundaries when messages arrive before its ACK',
  async mode => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(document.createElement('div'))
    let receive!: (message: ProjectChatMessage) => void
    let finish!: (value: unknown) => void
    const client = {
      subscribe: vi
        .fn()
        .mockResolvedValueOnce({
          snapshot: {
            messages: [createMessage({ messageId: 'old-window', sequenceNumber: 1 })],
            history: {
              firstSequence: 1,
              lastSequence: 1,
              hasOlder: false,
              hasNewer: true,
            },
          },
          unsubscribe: vi.fn(),
        })
        .mockImplementationOnce((_group, _thread, _after, onMessage) => {
          receive = onMessage
          return new Promise(resolve => {
            finish = resolve
          })
        }),
    } as unknown as ProjectChatClient
    let current!: ReturnType<typeof useIssueProjectChat>
    function Harness({ focus }: { focus?: string }) {
      current = useIssueProjectChat(
        client,
        'project-1',
        'issue-1',
        0,
        focus,
        undefined,
        'chat_group'
      )
      return null
    }
    try {
      await act(async () => root.render(<Harness focus="old-window" />))
      await act(async () =>
        root.render(<Harness focus={mode === 'history' ? 'window' : undefined} />)
      )
      act(() => receive(createMessage({ messageId: 'arriving', sequenceNumber: 201 })))
      await act(async () =>
        finish({
          snapshot: {
            messages: [createMessage({ messageId: 'window', sequenceNumber: 200 })],
            history: {
              firstSequence: 200,
              lastSequence: 200,
              hasOlder: true,
              hasNewer: false,
            },
          },
          unsubscribe: vi.fn(),
        })
      )
      expect(current.messages.map(message => message.messageId)).toEqual(
        mode === 'history' ? ['window'] : ['window', 'arriving']
      )
      expect(current.history?.hasNewer).toBe(true)
    } finally {
      act(() => root.unmount())
    }
  }
)

it('reads root group messages with a null scope without copying child Thread discussion', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const client = {
    subscribe: vi.fn().mockResolvedValue({
      snapshot: {
        messages: [
          createMessage({
            messageId: 'group-message',
            taskId: null,
            content: 'Group discussion',
          }),
          createMessage({
            messageId: 'thread-message',
            taskId: 'thread',
            content: 'Thread discussion',
          }),
        ],
      },
      unsubscribe: vi.fn(),
    }),
  } as unknown as ProjectChatClient
  let current!: ReturnType<typeof useIssueProjectChat>
  function Harness() {
    current = useIssueProjectChat(client, 'group', '')
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    expect(client.subscribe).toHaveBeenCalledWith(
      'group',
      '',
      0,
      expect.any(Function),
      expect.any(Function)
    )
    expect(current.messages.map(message => message.messageId)).toEqual(['group-message'])
  } finally {
    act(() => root.unmount())
  }
})

it('waits for the requested history anchor while retaining the current conversation', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  let resolveHistory!: (value: unknown) => void
  const client = {
    subscribe: vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: {
          messages: [createMessage({ messageId: 'latest', sequenceNumber: 200 })],
        },
        unsubscribe: vi.fn(),
      })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveHistory = resolve
          })
      ),
  } as unknown as ProjectChatClient
  let current!: ReturnType<typeof useIssueProjectChat>
  function Harness({ focus }: { focus?: string }) {
    current = useIssueProjectChat(client, 'project-1', 'issue-1', 0, focus)
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => root.render(<Harness focus="older" />))
    expect(current.loading).toBe(true)
    expect(current.messages.map(message => message.messageId)).toEqual(['latest'])
    expect(client.subscribe).toHaveBeenLastCalledWith(
      'project-1',
      'issue-1',
      0,
      expect.any(Function),
      expect.any(Function),
      { focusMessageId: 'older', historyWindow: true }
    )
    await act(async () =>
      resolveHistory({
        snapshot: {
          messages: [createMessage({ messageId: 'older', sequenceNumber: 1 })],
        },
        unsubscribe: vi.fn(),
      })
    )
    expect(current.loading).toBe(false)
    expect(current.messages.map(message => message.messageId)).toEqual(['older'])
  } finally {
    act(() => root.unmount())
  }
})

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
