import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceProjectAgent } from '@wegent/collaboration'
import '@/i18n'
import { ThreadAssigneeField } from './ThreadAssigneeField'

const agent = (id: string, name = 'Reviewer', status = 'active') =>
  ({ id, name, status }) as WorkspaceProjectAgent
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
function setup(
  list: SharedWorkspaceApi['agents']['list'],
  project: { id: string; name: string } | null = null
) {
  const props = {
    api: { list } as SharedWorkspaceApi['agents'],
    crews: {
      listCollaborationGroups: vi.fn().mockResolvedValue([]),
    } as unknown as SharedWorkspaceApi['projects'],
    groupCrews: {
      listCollaborationGroups: vi.fn().mockResolvedValue([]),
    } as unknown as SharedWorkspaceApi['projects'],
    canExecute: true,
    groupId: 'group',
    project,
    members: [],
    value: '',
    disabled: false,
    onChange: vi.fn(),
  }
  return { ...render(<ThreadAssigneeField {...props} />), props }
}

describe('Thread resource candidate sources', () => {
  it.each(['canUse', 'can_use'] as const)(
    'does not offer a currently unauthorized binding (%s)',
    async field => {
      const view = setup(
        vi
          .fn()
          .mockResolvedValue([
            { ...agent('revoked', 'Revoked agent'), [field]: false },
            agent('allowed', 'Allowed agent'),
          ])
      )
      await screen.findByRole('option', { name: 'Allowed agent' })
      expect(screen.queryByRole('option', { name: 'Revoked agent' })).not.toBeInTheDocument()
      view.rerender(
        <ThreadAssigneeField {...view.props} value="agent:revoked" assignedName="Revoked agent" />
      )
      expect(screen.getByRole('option', { name: 'Revoked agent' })).toBeDisabled()
      expect(view.props.onChange).not.toHaveBeenCalled()
    }
  )

  it('does not silently clear a former member assignment or change a read-only field', async () => {
    const view = setup(vi.fn().mockResolvedValue([agent('available')]))
    view.rerender(
      <ThreadAssigneeField
        {...view.props}
        value="user:former"
        assignedName="Former member"
        disabled
      />
    )
    expect(screen.getByRole('option', { name: 'Former member' })).toBeDisabled()
    await screen.findByRole('option', { name: 'Reviewer' })
    await userEvent.selectOptions(screen.getByTestId('thread-settings-assignee'), 'agent:available')
    expect(view.props.onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('thread-settings-assignee')).toHaveValue('user:former')
  })

  it('clears previous account candidates when the API identity changes', async () => {
    const view = setup(vi.fn().mockResolvedValue([agent('old', 'Old account agent')]))
    await screen.findByRole('option', { name: 'Old account agent' })
    const next = deferred<WorkspaceProjectAgent[]>()
    const api = { list: vi.fn(() => next.promise) } as unknown as SharedWorkspaceApi['agents']
    view.rerender(<ThreadAssigneeField {...view.props} api={api} />)
    expect(screen.queryByRole('option', { name: 'Old account agent' })).not.toBeInTheDocument()
    await act(async () => {
      next.resolve([agent('new', 'New account agent')])
      await next.promise
    })
    expect(screen.getByRole('option', { name: 'New account agent' })).toBeInTheDocument()
  })

  it('loads group agents without requiring a project and excludes archived bindings', async () => {
    const list = vi
      .fn()
      .mockResolvedValue([agent('group-agent'), agent('archived', 'Retired', 'archived')])
    const view = setup(list)
    await userEvent.selectOptions(
      await screen.findByTestId('thread-settings-assignee'),
      await screen.findByRole('option', { name: 'Reviewer' })
    )
    expect(view.props.onChange).toHaveBeenCalledWith('agent:group-agent')
    expect(list.mock.calls).toEqual([['group']])
    expect(screen.queryByRole('option', { name: 'Retired' })).not.toBeInTheDocument()
  })

  it('retains same-name agents under distinct group and project origins', async () => {
    const list = vi.fn(async (id: string) => [agent(`${id}-agent`)])
    const view = setup(list, { id: 'project', name: 'Plan' })
    const groupOptions = await screen.findByRole('group', { name: '来自本群' })
    const projectOptions = await screen.findByRole('group', { name: '来自项目：Plan' })
    expect(within(groupOptions).getByRole('option')).toHaveValue('agent:group-agent')
    await userEvent.selectOptions(
      screen.getByTestId('thread-settings-assignee'),
      within(projectOptions).getByRole('option')
    )
    expect(view.props.onChange).toHaveBeenCalledWith('agent:project-agent')
    expect(screen.getAllByRole('option', { name: 'Reviewer' })).toHaveLength(2)
  })

  it('keeps group candidates available when project access fails and supports recovery', async () => {
    let denied = true
    const list = vi.fn(async (id: string) => {
      if (id === 'project' && denied) throw new Error('Forbidden')
      return [agent(`${id}-agent`, id)]
    })
    setup(list, { id: 'project', name: 'Plan' })
    expect(await screen.findByRole('alert')).toHaveTextContent('部分执行资源未能加载')
    expect(screen.getByRole('option', { name: 'group' })).toBeEnabled()
    expect(screen.queryByRole('option', { name: 'project' })).not.toBeInTheDocument()
    denied = false
    await userEvent.click(screen.getByTestId('thread-assignees-retry'))
    expect(await screen.findByRole('option', { name: 'project' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('discards late candidates and clears old choices immediately when the owning scope changes', async () => {
    const old = deferred<WorkspaceProjectAgent[]>()
    const list = vi.fn((id: string) =>
      id === 'group' ? old.promise : Promise.resolve([agent('new', 'New group agent')])
    )
    const view = setup(list)
    view.rerender(<ThreadAssigneeField {...view.props} groupId="new-group" />)
    expect(await screen.findByRole('option', { name: 'New group agent' })).toBeInTheDocument()
    await act(async () => {
      old.resolve([agent('stale', 'Old group private agent')])
      await old.promise
    })
    expect(
      screen.queryByRole('option', { name: 'Old group private agent' })
    ).not.toBeInTheDocument()
  })

  it('preserves unavailable historical assignments without offering them for new selection', async () => {
    const view = setup(vi.fn().mockResolvedValue([]))
    view.rerender(
      <ThreadAssigneeField {...view.props} value="agent:removed" assignedName="Former agent" />
    )
    expect(await screen.findByRole('option', { name: 'Former agent' })).toBeDisabled()
    expect(screen.getByTestId('thread-settings-assignee')).toHaveValue('agent:removed')
    expect(view.props.onChange).not.toHaveBeenCalled()
  })
  it('offers duplicate crew IDs under their actual sources and returns separate raw ID and source', async () => {
    const view = setup(vi.fn().mockResolvedValue([]), { id: 'project', name: 'Plan' })
    const crews = {
      listCollaborationGroups: vi.fn(async () => [{ id: 'same', name: 'Delivery' }]),
    } as unknown as SharedWorkspaceApi['projects']
    view.rerender(<ThreadAssigneeField {...view.props} crews={crews} groupCrews={crews} />)
    const group = await screen.findByRole('group', { name: '来自本群' })
    const project = await screen.findByRole('group', { name: '来自项目：Plan' })
    const option = within(project).getByRole('option', { name: '小组：Delivery' })
    expect(within(group).getByRole('option').getAttribute('value')).not.toBe(
      option.getAttribute('value')
    )
    await userEvent.selectOptions(screen.getByTestId('thread-settings-assignee'), option)
    expect(view.props.onChange).toHaveBeenCalledWith('group:same', 'project')
  })

  it('preserves a historical crew with no source instead of silently selecting a same-ID candidate', async () => {
    const view = setup(vi.fn().mockResolvedValue([]))
    const crews = {
      listCollaborationGroups: vi.fn().mockResolvedValue([{ id: 'same', name: 'Current crew' }]),
    } as unknown as SharedWorkspaceApi['projects']
    view.rerender(
      <ThreadAssigneeField
        {...view.props}
        crews={crews}
        groupCrews={crews}
        value="group:same"
        assignedName="Historical crew"
      />
    )
    await screen.findByRole('option', { name: '小组：Current crew' })
    expect(screen.getByRole('option', { name: 'Historical crew' })).toBeDisabled()
    expect(screen.getByTestId('thread-settings-assignee')).toHaveValue('group:same')
    expect(view.props.onChange).not.toHaveBeenCalled()
  })

  it('keeps usable agents when loading crews fails and exposes retry', async () => {
    const view = setup(vi.fn().mockResolvedValue([agent('available', 'Available agent')]))
    const crews = {
      listCollaborationGroups: vi.fn().mockRejectedValue(new Error('Denied')),
    } as unknown as SharedWorkspaceApi['projects']
    view.rerender(<ThreadAssigneeField {...view.props} crews={crews} groupCrews={crews} />)
    await screen.findByRole('option', { name: 'Available agent' })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('thread-assignees-retry')).toBeEnabled()
  })
})
