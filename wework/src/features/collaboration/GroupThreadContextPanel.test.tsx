import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import { ApiError } from '@/api/http'
import type { WorkItemContextPanelProps } from '@/features/todo/WorkItemContextPanel'
import '@/i18n'
import { GroupThreadContextPanel } from './GroupThreadContextPanel'
import type { GroupConversation } from './GroupConversation'

const host = vi.hoisted(() => ({ room: null as ComponentProps<typeof GroupConversation> | null }))
vi.mock('./GroupConversation', () => ({
  GroupConversation: (props: ComponentProps<typeof GroupConversation>) => {
    host.room = props
    return (
      <div data-testid="embedded-room">
        <h1>{props.item!.title}</h1>
        <span>{props.group.name}</span>
        <button data-testid="refresh-room" onClick={props.onChanged}>
          Refresh
        </button>
        <button data-testid="open-child" onClick={() => props.onOpenThread('child')}>
          Child
        </button>
      </div>
    )
  },
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
function fixture() {
  const group = {
    id: 'group',
    project_key: 'GROUP',
    name: 'Actual group',
    status: 'active',
    role: 'Viewer',
    version: 1,
  }
  const item = {
    id: 'thread',
    group_id: 'group',
    cloud_project_id: 'group',
    title: 'Actual Thread',
    status: 'pending',
    version: 1,
  } as CollaborationIssue
  const get = vi.fn().mockResolvedValue(item)
  const list = vi
    .fn()
    .mockResolvedValue([
      item,
      { ...item, id: 'foreign', group_id: 'other', cloud_project_id: 'other' },
    ])
  const groupGet = vi.fn().mockResolvedValue({ group, members: [] })
  const base = { issues: { get, list } } as unknown as SharedWorkspaceApi
  const api = { getLoopItem: vi.fn(), listCloudProjects: vi.fn() }
  const props = {
    project: { id: 'group', resource_type: 'chat_group', project_store: 'backend' },
    item,
    api,
    services: { sharedWorkspaceApi: base, chatGroupApis: { cloud: { get: groupGet } } },
    currentUserId: 7,
    localProjects: [],
    onOpenTask: vi.fn(),
    active: true,
  } as unknown as WorkItemContextPanelProps
  return { props, item, group, get, list, groupGet, api }
}
afterEach(() => {
  host.room = null
  localStorage.clear()
})

describe('embedded Group Thread context', () => {
  it('loads the actual Group without a Project catalog and preserves focus/authorized hierarchy', async () => {
    const f = fixture()
    render(
      <GroupThreadContextPanel
        {...f.props}
        focusedCommentId="message"
        focusedCommentRequestKey="focus"
      />
    )
    await screen.findByText('Actual Thread')
    expect(f.groupGet).toHaveBeenCalledExactlyOnceWith('group')
    expect(f.get).toHaveBeenCalledExactlyOnceWith('thread')
    expect(f.list).toHaveBeenCalledExactlyOnceWith('group')
    expect(f.api.listCloudProjects).not.toHaveBeenCalled()
    expect(host.room).toMatchObject({
      group: f.group,
      item: f.item,
      members: [],
      focusedCommentId: 'message',
      focusRequestKey: 'focus',
      items: [f.item],
    })
    expect(host.room!.project).toMatchObject({
      id: 'group',
      resource_type: 'chat_group',
      access_role: 'Viewer',
    })
    act(() => host.room!.onClearFocus())
    expect(host.room!.focusedCommentId).toBeNull()
  })

  it('does not treat the optional classification Project as the work owner', async () => {
    const f = fixture()
    render(
      <GroupThreadContextPanel
        {...f.props}
        project={{ ...f.props.project, id: 'classification' }}
      />
    )
    await screen.findByRole('alert')
    expect(f.groupGet).not.toHaveBeenCalled()
    expect(f.get).not.toHaveBeenCalled()
    expect(screen.queryByTestId('embedded-room')).toBeNull()
  })

  it('retains the same room on a transient refresh error, but clears it on revocation and recovers on retry', async () => {
    const f = fixture()
    render(<GroupThreadContextPanel {...f.props} />)
    const room = await screen.findByTestId('embedded-room')
    f.list.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByTestId('refresh-room'))
    await screen.findByTestId('thread-context-refresh-retry')
    expect(screen.getByTestId('embedded-room')).toBe(room)
    f.groupGet.mockRejectedValueOnce(new ApiError('revoked', 403))
    fireEvent.click(screen.getByTestId('thread-context-refresh-retry'))
    await screen.findByTestId('thread-context-retry')
    expect(screen.queryByTestId('embedded-room')).toBeNull()
    fireEvent.click(screen.getByTestId('thread-context-retry'))
    await screen.findByTestId('embedded-room')
  })

  it('discards the old room when a fresh item belongs to a different Group', async () => {
    const f = fixture()
    render(<GroupThreadContextPanel {...f.props} />)
    await screen.findByTestId('embedded-room')
    f.get.mockResolvedValueOnce({ ...f.item, group_id: 'other', cloud_project_id: 'other' })
    fireEvent.click(screen.getByTestId('refresh-room'))
    await screen.findByTestId('thread-context-retry')
    expect(screen.queryByTestId('embedded-room')).toBeNull()
  })

  it('drops already loaded content immediately on account change and ignores the old account late response', async () => {
    const f = fixture()
    const mounted = render(<GroupThreadContextPanel {...f.props} />)
    await screen.findByTestId('embedded-room')
    const old = deferred<CollaborationIssue>()
    f.get.mockReturnValueOnce(old.promise)
    fireEvent.click(screen.getByTestId('refresh-room'))
    await waitFor(() => expect(f.get).toHaveBeenCalledTimes(2))
    const next = deferred<CollaborationIssue>()
    f.get.mockReturnValueOnce(next.promise)
    mounted.rerender(<GroupThreadContextPanel {...f.props} currentUserId={8} />)
    expect(screen.queryByTestId('embedded-room')).toBeNull()
    await act(async () => {
      old.resolve({ ...f.item, title: 'Old account late' })
    })
    expect(screen.queryByTestId('embedded-room')).toBeNull()
    await act(async () => {
      next.resolve({ ...f.item, title: 'Current account' })
    })
    await screen.findByText('Current account')
    expect(screen.queryByText('Old account late')).toBeNull()
  })

  it('loads only while active and refetches when the owning item version changes', async () => {
    const f = fixture()
    const mounted = render(<GroupThreadContextPanel {...f.props} active={false} />)
    expect(f.get).not.toHaveBeenCalled()
    mounted.rerender(<GroupThreadContextPanel {...f.props} />)
    await screen.findByTestId('embedded-room')
    f.get.mockResolvedValueOnce({ ...f.item, version: 2, title: 'Updated by Runtime' })
    mounted.rerender(
      <GroupThreadContextPanel {...f.props} item={{ ...f.props.item, version: 2 }} />
    )
    await screen.findByText('Updated by Runtime')
    expect(host.room?.active).toBe(true)
    mounted.rerender(
      <GroupThreadContextPanel {...f.props} active={false} item={{ ...f.props.item, version: 2 }} />
    )
    expect(host.room?.active).toBe(false)
  })

  it('loads the real related item before delegating and rejects a foreign Group target', async () => {
    const f = fixture()
    const onOpenChildTask = vi.fn()
    render(<GroupThreadContextPanel {...f.props} onOpenChildTask={onOpenChildTask} />)
    await screen.findByTestId('embedded-room')
    const child = { ...f.item, id: 'child', title: 'Real child' }
    f.api.getLoopItem.mockResolvedValueOnce(child)
    fireEvent.click(screen.getByTestId('open-child'))
    await waitFor(() => expect(onOpenChildTask).toHaveBeenCalledWith(child))
    f.api.getLoopItem.mockResolvedValueOnce({ ...child, group_id: 'other' })
    fireEvent.click(screen.getByTestId('open-child'))
    await screen.findByTestId('transient-notice')
    expect(onOpenChildTask).toHaveBeenCalledOnce()
  })
})

it('keeps native participant 0 separate from the signed-in account used to isolate interface state', async () => {
  const f = fixture()
  const nativeApi = {
    ...f.api,
    getLoopItem: vi.fn().mockResolvedValue(f.item),
    listLoopItems: vi.fn().mockResolvedValue({ items: [f.item] }),
  }
  const nativeProps = {
    ...f.props,
    api: nativeApi,
    project: { ...f.props.project, project_store: 'local' },
    services: {
      chatGroupApis: { local: { get: f.groupGet } },
      localParticipationIdentity: { currentUser: { id: 0, name: 'Native user' } },
    },
  } as unknown as WorkItemContextPanelProps
  const mounted = render(<GroupThreadContextPanel {...nativeProps} />)
  await screen.findByTestId('embedded-room')
  const oldAccountScope = host.room!.accountScope
  const next = deferred<CollaborationIssue>()
  nativeApi.getLoopItem.mockReturnValueOnce(next.promise)
  mounted.rerender(<GroupThreadContextPanel {...nativeProps} currentUserId={8} />)
  expect(screen.queryByTestId('embedded-room')).toBeNull()
  await act(async () => {
    next.resolve(f.item)
  })
  await screen.findByTestId('embedded-room')
  expect(host.room!.accountScope).not.toBe(oldAccountScope)
  expect(host.room!.accountScope).toContain('8')
  expect(f.api.listCloudProjects).not.toHaveBeenCalled()
  expect(f.get).not.toHaveBeenCalled()
})
