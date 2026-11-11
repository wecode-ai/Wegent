import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import '@/i18n'
import { GroupConversation } from './GroupConversation'
import type { GroupMessageComposer } from './GroupMessageComposer'
import { groupBoardContext } from './groupWorkspaceApi'
import type { ThreadActionContext } from './threadActions'

const state = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue(undefined),
  composer: null as ComponentProps<typeof GroupMessageComposer> | null,
}))
const message: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'original',
  projectId: 'group',
  sender: { type: 'user', id: '8', name: '林悦' },
  type: 'text',
  content: '原讨论',
  metadata: {},
  status: 'completed',
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
}
vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  useIssueProjectChat: () => ({
    messages: [message],
    currentUserId: '7',
    loading: false,
    error: null,
    send: state.send,
  }),
}))
vi.mock('./GroupMessageComposer', () => ({
  GroupMessageComposer: (props: ComponentProps<typeof GroupMessageComposer>) => {
    state.composer = props
    return <div data-testid="composer-target">{props.replyTarget?.messageId}</div>
  },
}))

vi.mock('./ThreadSettings', () => ({
  ThreadSettings: () => <div data-testid="thread-settings-panel" />,
}))

const group = { id: 'group', name: 'Design', role: 'Developer', status: 'active' } as ChatGroup
const item = {
  id: 'thread',
  group_id: group.id,
  cloud_project_id: group.id,
  title: 'Review',
  status: 'pending',
  sequence_number: 1,
} as CollaborationIssue
const api = {} as SharedWorkspaceApi
const props = {
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
      joined: true,
      can_comment: true,
      show_in_sidebar: true,
    })),
  } as unknown as ChatGroupApi,
  chat: {} as ProjectChatClient,
  locale: 'zh-CN' as const,
  accountScope: 'account-one',
  onOpenThread: vi.fn(),
  onBack: vi.fn(),
  onChanged: vi.fn(),
  onClearFocus: vi.fn(),
}

describe('Group conversation reply ownership', () => {
  it('passes the selected message relationship and structured mentions to the existing stream', async () => {
    render(<GroupConversation {...props} />)
    fireEvent.click(await screen.findByTestId('group-message-reply-original'))
    expect(screen.getByTestId('composer-target')).toHaveTextContent('original')
    const composer = state.composer!
    const mentions = [{ type: 'user' as const, id: '8', label: '林悦' }]
    await composer.onSend('@林悦 已确认', composer.replyTarget!.messageId, mentions)
    expect(state.send).toHaveBeenLastCalledWith('@林悦 已确认', 'original', mentions)
  })

  it('clears a reply when the account changes and never reuses it on returning', async () => {
    const view = render(<GroupConversation {...props} />)
    fireEvent.click(await screen.findByTestId('group-message-reply-original'))
    expect(screen.getByTestId('composer-target')).toHaveTextContent('original')
    view.rerender(<GroupConversation {...props} accountScope="account-two" />)
    expect(screen.getByTestId('composer-target')).toBeEmptyDOMElement()
    view.rerender(<GroupConversation {...props} />)
    expect(screen.getByTestId('composer-target')).toBeEmptyDOMElement()
  })

  it('withholds reply actions from observers even when their group role permits writing', async () => {
    render(
      <GroupConversation
        {...props}
        groups={
          {
            participation: vi.fn(async () => ({
              current_user_id: 7,
              participants: [],
              joined: false,
              can_comment: false,
              show_in_sidebar: false,
            })),
          } as unknown as ChatGroupApi
        }
      />
    )
    await waitFor(() => expect(screen.getByTestId('thread-join')).toBeVisible())
    expect(screen.queryByTestId('group-message-reply-original')).not.toBeInTheDocument()
  })
  it('keeps metadata open until the existing leave guard accepts a notification work action', async () => {
    let accepted: (() => void) | undefined
    let context: ThreadActionContext | null = null
    const action = vi.fn()
    render(
      <GroupConversation
        {...props}
        requestLeave={callback => {
          accepted = callback
        }}
        onThreadActionContext={value => {
          context = value
        }}
      />
    )
    await waitFor(() => expect(context).not.toBeNull())
    fireEvent.click(screen.getByTestId('thread-settings'))
    expect(screen.getByTestId('thread-settings-panel')).toBeVisible()
    act(() => context!.requestLeave(action))
    expect(screen.getByTestId('thread-settings-panel')).toBeVisible()
    expect(action).not.toHaveBeenCalled()
    act(() => accepted!())
    expect(screen.queryByTestId('thread-settings-panel')).not.toBeInTheDocument()
    expect(action).toHaveBeenCalledOnce()
  })
})
