import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { GroupConversation } from './GroupConversation'
import { groupBoardContext } from './groupWorkspaceApi'

const group: ChatGroup = {
  id: 'group',
  project_key: 'G',
  name: 'Design',
  description: '',
  status: 'active',
  version: 1,
  role: 'Viewer',
  created_by_user_id: 7,
  created_at: '2026-11-11T00:00:00Z',
  updated_at: '2026-11-11T00:00:00Z',
}
const item: CollaborationIssue = {
  id: 'G-1',
  cloud_project_id: group.id,
  sequence_number: 1,
  title: 'Review',
  description: '',
  status: 'pending',
  priority: 'none',
  parent_id: null,
  assignee_user_id: null,
  created_by_user_id: 7,
  tags: [],
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: group.created_at,
  updated_at: group.updated_at,
  completed_at: null,
}

describe('Thread reading and notification participation', () => {
  it('provides a named return to the originating board', async () => {
    const onBackToBoard = vi.fn()
    const api = {} as SharedWorkspaceApi
    render(
      <GroupConversation
        group={group}
        project={groupBoardContext(group, 'local')}
        item={item}
        items={[item]}
        api={api}
        catalog={api}
        members={[]}
        groups={
          {
            participation: vi.fn(async () => ({ participants: [], joined: false })),
          } as unknown as ChatGroupApi
        }
        chat={undefined}
        locale="zh-CN"
        onOpenThread={vi.fn()}
        onBack={vi.fn()}
        onBackToBoard={onBackToBoard}
        onChanged={vi.fn()}
        onClearFocus={vi.fn()}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: '返回看板' }))
    expect(onBackToBoard).toHaveBeenCalledOnce()
  })
  it('refreshes the participant count when membership changes without editing Thread metadata', async () => {
    const reader = { user_id: 8, name: 'Reader', notifications: 'all' }
    const participation = vi
      .fn()
      .mockResolvedValueOnce({
        current_user_id: 8,
        joined: true,
        can_comment: false,
        show_in_sidebar: true,
        participants: [reader],
      })
      .mockResolvedValueOnce({
        current_user_id: 8,
        joined: true,
        can_comment: false,
        show_in_sidebar: true,
        participants: [reader, { ...reader, user_id: 9, name: 'Another reader' }],
      })
    const groups = { participation } as unknown as ChatGroupApi
    const api = {} as SharedWorkspaceApi
    const props = {
      group,
      project: groupBoardContext(group, 'local'),
      items: [item],
      api,
      catalog: api,
      members: [],
      groups,
      chat: undefined,
      locale: 'zh-CN' as const,
      onOpenThread: vi.fn(),
      onBack: vi.fn(),
      onChanged: vi.fn(),
      onClearFocus: vi.fn(),
    }
    const view = render(<GroupConversation {...props} item={item} />)
    await screen.findByText('1 人参与')
    view.rerender(<GroupConversation {...props} item={{ ...item }} />)
    await screen.findByText('2 人参与')
  })
  it('does not offer subscription writes that an archived group rejects', async () => {
    const archived = { ...group, status: 'archived' as const }
    const groups = {
      participation: vi.fn(async () => ({
        current_user_id: 8,
        joined: true,
        can_comment: false,
        show_in_sidebar: false,
        participants: [{ user_id: 8, name: 'Reader', notifications: 'all' }],
      })),
      setParticipation: vi.fn(),
    } as unknown as ChatGroupApi
    const api = {} as SharedWorkspaceApi
    render(
      <GroupConversation
        group={archived}
        project={groupBoardContext(archived, 'local')}
        item={item}
        items={[item]}
        api={api}
        catalog={api}
        members={[]}
        groups={groups}
        chat={undefined}
        locale="zh-CN"
        onOpenThread={vi.fn()}
        onBack={vi.fn()}
        onChanged={vi.fn()}
        onClearFocus={vi.fn()}
      />
    )
    await screen.findByText('1 人参与')
    fireEvent.click(screen.getByTestId('thread-more'))
    expect(await screen.findByTestId('thread-menu-settings')).toBeVisible()
    expect(screen.queryByTestId('thread-menu-notifications')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thread-menu-leave')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thread-menu-lifecycle')).not.toBeInTheDocument()
    expect(groups.setParticipation).not.toHaveBeenCalled()
  })
  it('lets a Viewer join for notifications without offering discussion or completion', async () => {
    const observer = {
      current_user_id: 8,
      participants: [],
      joined: false,
      can_comment: false,
      show_in_sidebar: false,
    }
    const setParticipation = vi.fn(async () => ({
      ...observer,
      joined: true,
      show_in_sidebar: true,
      participants: [{ user_id: 8, name: 'Reader', notifications: 'all' }],
    }))
    const groups = {
      participation: vi.fn(async () => observer),
      setParticipation,
    } as unknown as ChatGroupApi
    const changed = vi.fn()
    const api = {} as SharedWorkspaceApi
    render(
      <GroupConversation
        group={group}
        project={groupBoardContext(group, 'local')}
        item={item}
        items={[item]}
        api={api}
        catalog={api}
        members={[]}
        groups={groups}
        chat={undefined}
        locale="zh-CN"
        onOpenThread={vi.fn()}
        onBack={vi.fn()}
        onChanged={changed}
        onClearFocus={vi.fn()}
      />
    )

    expect(await screen.findByTestId('thread-join')).toHaveTextContent('加入并接收提醒')
    expect(screen.getByTestId('thread-observer')).toHaveTextContent('当前角色仅可查看')
    expect(screen.queryByTestId('group-message-input')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('thread-join'))
    await waitFor(() => expect(setParticipation).toHaveBeenCalledWith(item.id, { joined: true }))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('thread-join')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-message-input')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('thread-more'))
    expect(screen.queryByTestId('thread-menu-lifecycle')).not.toBeInTheDocument()
    expect(await screen.findByTestId('thread-menu-notifications')).toBeVisible()
  })
})
