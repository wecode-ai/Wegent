import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ProjectChatClient } from '@wegent/chat-core'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import '@/i18n'
import { GroupConversation } from './GroupConversation'
import { groupBoardContext } from './groupWorkspaceApi'

const stream = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  historyView: true,
}))
vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  useIssueProjectChat: () => ({
    ...stream,
    currentUserId: '7',
    messages: [
      {
        messageId: 'old-message',
        sequenceNumber: 9999,
        projectId: 'group',
        sender: { type: 'user', id: '8', name: 'Colleague' },
        content: 'Historical discussion remains visible',
        metadata: {},
        type: 'text',
        status: 'completed',
        createdAt: '2026-11-11T00:00:00Z',
      },
    ],
    send: vi.fn(),
    history: { firstSequence: 9999, lastSequence: 9999, hasOlder: false, hasNewer: true },
  }),
}))
const group = { id: 'group', name: 'Design', role: 'Viewer', status: 'active' } as ChatGroup
const item = {
  id: 'thread',
  cloud_project_id: 'group',
  group_id: 'group',
  title: 'Review',
  status: 'pending',
  content_revision: 4,
  is_unread: true,
  version: 4,
  sequence_number: 1,
} as CollaborationIssue
function fixture() {
  const markRead = vi.fn().mockResolvedValue({ ...item, is_unread: false })
  const api = { issues: { markRead } } as unknown as SharedWorkspaceApi
  const join = vi.fn()
  const props: ComponentProps<typeof GroupConversation> = {
    group,
    project: groupBoardContext(group, 'local'),
    item,
    items: [item],
    api,
    catalog: api,
    members: [],
    groups: {
      participation: vi.fn(async () => ({
        current_user_id: 7,
        participants: [],
        joined: false,
        can_comment: false,
        show_in_sidebar: false,
      })),
      setParticipation: join,
    } as unknown as ChatGroupApi,
    chat: {} as ProjectChatClient,
    locale: 'zh-CN',
    accountScope: 'account',
    onOpenThread: vi.fn(),
    onBack: vi.fn(),
    onChanged: vi.fn(),
    onClearFocus: vi.fn(),
  }
  return { props, markRead, join }
}
beforeEach(() => {
  stream.loading = false
  stream.error = null
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 400,
    height: 300,
    top: 0,
    bottom: 300,
    left: 0,
    right: 400,
    x: 0,
    y: 0,
    toJSON() {},
  })
})
afterEach(() => vi.restoreAllMocks())

describe('GroupConversation content receipts', () => {
  it('lets an unjoined viewer read metadata without joining or acknowledging historical chat9999', async () => {
    const { props, markRead, join } = fixture()
    render(<GroupConversation {...props} />)
    await waitFor(() => expect(markRead).toHaveBeenCalledExactlyOnceWith('thread', 0, 4))
    expect(screen.getByTestId('thread-observer')).toBeVisible()
    expect(screen.getByTestId('group-history-window')).toBeVisible()
    expect(screen.getByText('Historical discussion remains visible')).toBeVisible()
    expect(join).not.toHaveBeenCalled()
    expect(props.onChanged).toHaveBeenCalledOnce()
  })

  it('waits for the active loaded room before confirming its content', async () => {
    const { props, markRead } = fixture()
    const view = render(<GroupConversation {...props} active={false} />)
    await screen.findByTestId('thread-observer')
    expect(markRead).not.toHaveBeenCalled()
    stream.loading = true
    view.rerender(<GroupConversation {...props} active />)
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(markRead).not.toHaveBeenCalled()
    stream.loading = false
    view.rerender(<GroupConversation {...props} active />)
    await waitFor(() => expect(markRead).toHaveBeenCalledOnce())
  })

  it('reports a retryable read failure without hiding the loaded discussion', async () => {
    const { props, markRead } = fixture()
    markRead.mockRejectedValueOnce(new Error('offline'))
    render(<GroupConversation {...props} />)
    expect(await screen.findByTestId('thread-read-error')).toHaveTextContent('已读状态未能更新')
    expect(screen.getByText('Historical discussion remains visible')).toBeVisible()
    fireEvent.click(screen.getByTestId('thread-read-retry'))
    await waitFor(() => expect(screen.queryByTestId('thread-read-error')).not.toBeInTheDocument())
    expect(markRead.mock.calls).toEqual([
      ['thread', 0, 4],
      ['thread', 0, 4],
    ])
  })
})
