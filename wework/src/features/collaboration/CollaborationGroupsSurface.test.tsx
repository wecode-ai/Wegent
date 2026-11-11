import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { CollaborationGroupsSurface, type GroupSource } from './CollaborationGroupsSurface'

function source(store: GroupSource['store'], name: string, pending: () => boolean): GroupSource {
  const group: ChatGroup = {
    id: `${store}-group`,
    project_key: 'G',
    name,
    description: '',
    status: 'active',
    version: 1,
    role: 'Owner',
    created_by_user_id: 7,
    created_at: '2026-11-11T00:00:00Z',
    updated_at: '2026-11-11T00:00:00Z',
  }
  const next = <T,>(value: T): Promise<T> =>
    pending() ? new Promise(() => {}) : Promise.resolve(value)
  return {
    store,
    groups: {
      list: vi.fn(() => next({ items: [group] })),
      navigation: vi.fn(() =>
        next({
          items: [
            {
              id: `${store}-thread`,
              group_id: group.id,
              title: `${name} Thread`,
              status: 'pending',
            },
          ],
        })
      ),
      get: vi.fn(() => next({ group, members: [] })),
    } as unknown as ChatGroupApi,
    workspace: { issues: { list: vi.fn(() => next([])) } } as unknown as SharedWorkspaceApi,
  }
}

describe('Group authority scope changes', () => {
  it('hides prior-account group details and navigation before the next account responds', async () => {
    let switched = false
    const sources = [source('cloud', 'Private account A group', () => switched)]
    const props = {
      sources,
      search: '?groupStore=cloud&groupId=cloud-group',
      locale: 'zh-CN' as const,
      onNavigate: vi.fn(),
      onReady: vi.fn(),
    }
    const view = render(<CollaborationGroupsSurface {...props} accountScope="account-a" />)
    await screen.findByRole('heading', { name: 'Private account A group' })
    expect(screen.getByTestId('thread-nav-cloud-thread')).toBeVisible()
    switched = true
    view.rerender(<CollaborationGroupsSurface {...props} accountScope="account-b" />)
    expect(screen.queryAllByText('Private account A group')).toHaveLength(0)
    expect(screen.queryByTestId('thread-nav-cloud-thread')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-nav-cloud-group')).not.toBeInTheDocument()
  })

  it('keeps local group content while hiding the prior cloud account catalog', async () => {
    let switched = false
    const sources = [
      source('local', 'Independent local group', () => switched),
      source('cloud', 'Private cloud group', () => switched),
    ]
    const props = {
      sources,
      search: '?groupStore=local&groupId=local-group',
      locale: 'zh-CN' as const,
      onNavigate: vi.fn(),
      onReady: vi.fn(),
    }
    const view = render(<CollaborationGroupsSurface {...props} accountScope="account-a" />)
    await screen.findByRole('heading', { name: 'Independent local group' })
    await screen.findByTestId('group-nav-cloud-group')
    switched = true
    view.rerender(<CollaborationGroupsSurface {...props} accountScope="account-b" />)
    expect(screen.getByRole('heading', { name: 'Independent local group' })).toBeVisible()
    expect(screen.getByTestId('group-nav-local-group')).toBeVisible()
    expect(screen.queryByTestId('group-nav-cloud-group')).not.toBeInTheDocument()
  })
})
