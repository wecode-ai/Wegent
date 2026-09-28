// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import { useIssueProjectChat } from './useIssueProjectChat'

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
        { ...oldMessage, messageId: 'new', taskId: 'issue-2', content: 'New comment' },
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
    expect(container.textContent).toContain(
      '负责人已综合证据，将 Issue 提交待确认。'
    )
  } finally {
    act(() => root.unmount())
  }
})
