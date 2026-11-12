import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import type { GroupConversation } from './GroupConversation'
import type { ThreadCreateDialog } from './ThreadCreateDialog'
import { CollaborationGroupsSurface, type GroupSource } from './CollaborationGroupsSurface'

const dialogs = vi.hoisted(() => ({
  current: null as ComponentProps<typeof ThreadCreateDialog> | null,
}))
vi.mock('./GroupConversation', () => ({
  GroupConversation: (props: ComponentProps<typeof GroupConversation>) =>
    props.item && (
      <div>
        <button data-testid="request-child" onClick={() => props.onCreateChild?.(props.item!)}>
          Child
        </button>
        <button data-testid="open-related" onClick={() => props.onOpenRelatedThread?.('other')}>
          Related
        </button>
        <button data-testid="open-direct" onClick={() => props.onOpenThread('other')}>
          Direct
        </button>
      </div>
    ),
}))
vi.mock('./ThreadCreateDialog', () => ({
  ThreadCreateDialog: (props: ComponentProps<typeof ThreadCreateDialog>) => {
    dialogs.current = props
    return (
      <button data-testid="child-dialog" onClick={props.form.onClose}>
        Close child
      </button>
    )
  },
}))

function fixture() {
  const group: ChatGroup = {
    id: 'group',
    project_key: 'G',
    name: 'Local group',
    description: '',
    status: 'active',
    version: 1,
    role: 'Owner',
    created_by_user_id: 0,
    created_at: '2026-11-11T00:00:00Z',
    updated_at: '2026-11-11T00:00:00Z',
  }
  const parent = {
    id: 'parent',
    group_id: group.id,
    cloud_project_id: group.id,
    title: 'Parent',
    status: 'pending',
    version: 1,
  } as CollaborationIssue
  const other = { ...parent, id: 'other', title: 'Other' }
  const source: GroupSource = {
    store: 'local',
    groups: {
      list: vi.fn(async () => ({ items: [group] })),
      get: vi.fn(async () => ({ group, members: [] })),
      navigation: vi.fn(async () => ({ items: [] })),
    } as unknown as ChatGroupApi,
    workspace: {
      issues: { list: vi.fn(async () => [parent, other]) },
    } as unknown as SharedWorkspaceApi,
  }
  const props = {
    sources: [source],
    search:
      '?collaborationView=groups&groupStore=local&groupId=group&threadId=parent&groupTab=chat',
    locale: 'zh-CN' as const,
    accountScope: 'account-a',
    onNavigate: vi.fn(),
    onReady: vi.fn(),
  }
  return { props, parent, child: { ...parent, id: 'child', parent_id: parent.id } }
}

describe('Group child creation lifetime', () => {
  it('uses the actual parent and marks only explicit hierarchy navigation as related', async () => {
    const { props, parent, child } = fixture()
    render(<CollaborationGroupsSurface {...props} />)
    fireEvent.click(await screen.findByTestId('open-related'))
    expect(props.onNavigate.mock.calls[0][1]).toBe(parent.id)
    expect(new URLSearchParams(props.onNavigate.mock.calls[0][0]).get('threadId')).toBe('other')
    props.onNavigate.mockClear()
    fireEvent.click(screen.getByTestId('open-direct'))
    expect(props.onNavigate.mock.calls[0]).toHaveLength(1)
    props.onNavigate.mockClear()
    fireEvent.click(screen.getByTestId('request-child'))
    await screen.findByTestId('child-dialog')
    expect(dialogs.current?.form.defaults?.parent).toEqual(parent)
    expect(dialogs.current?.store).toBe('local')
    await act(async () => dialogs.current!.form.onCreated(child))
    expect(props.onNavigate.mock.calls[0][1]).toBe(parent.id)
    expect(new URLSearchParams(props.onNavigate.mock.calls[0][0]).get('threadId')).toBe(child.id)
  })

  it('does not accept completion of a child dialog that was closed', async () => {
    const { props, child } = fixture()
    render(<CollaborationGroupsSurface {...props} />)
    fireEvent.click(await screen.findByTestId('request-child'))
    fireEvent.click(await screen.findByTestId('child-dialog'))
    const closed = dialogs.current!
    await act(async () => closed.form.onCreated(child))
    expect(props.onNavigate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('child-dialog')).not.toBeInTheDocument()
  })

  it.each(['account', 'thread'] as const)(
    'discards a local child draft when its %s scope changes',
    async kind => {
      const { props, child } = fixture()
      const view = render(<CollaborationGroupsSurface {...props} />)
      fireEvent.click(await screen.findByTestId('request-child'))
      await screen.findByTestId('child-dialog')
      const previous = dialogs.current!
      view.rerender(
        <CollaborationGroupsSurface
          {...props}
          accountScope={kind === 'account' ? 'account-b' : props.accountScope}
          search={
            kind === 'thread'
              ? props.search.replace('threadId=parent', 'threadId=other')
              : props.search
          }
        />
      )
      expect(screen.queryByTestId('child-dialog')).not.toBeInTheDocument()
      await act(async () => previous.form.onCreated(child))
      expect(props.onNavigate).not.toHaveBeenCalled()
      view.rerender(<CollaborationGroupsSurface {...props} />)
      expect(screen.queryByTestId('child-dialog')).not.toBeInTheDocument()
    }
  )
})
