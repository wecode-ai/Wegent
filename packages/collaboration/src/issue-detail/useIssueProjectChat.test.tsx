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
