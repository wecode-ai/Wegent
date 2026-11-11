import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CollaborationProject } from '@wegent/collaboration'
import type { GroupSource } from './CollaborationGroupsSurface'
import { ThreadCreationHome } from './ThreadCreationHome'

const inspect = vi.hoisted(() => vi.fn())
vi.mock('./ThreadCreateDialog', () => ({
  ThreadCreateDialog: (props: unknown) => {
    inspect(props)
    return <div data-testid="test-thread-dialog" />
  },
}))

const local = { store: 'local', workspace: {}, groups: {} } as GroupSource
const cloud = { store: 'cloud', workspace: {}, groups: {} } as GroupSource
const project = {
  id: 'P1',
  name: '产品项目',
  project_store: 'local',
  status: 'active',
  access_role: 'Developer',
} as CollaborationProject

describe('Thread creation home', () => {
  it('allows creating in a group without a project or workspace', () => {
    render(
      <ThreadCreationHome
        accountScope="fixture:user-7"
        sources={[local]}
        projects={[]}
        locale="zh-CN"
      />
    )
    fireEvent.click(screen.getByTestId('thread-home-create'))
    expect(screen.getByTestId('test-thread-dialog')).toBeInTheDocument()
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        api: local.workspace,
        groups: local.groups,
        store: 'local',
        form: expect.objectContaining({ project: undefined }),
      })
    )
  })

  it('offers only editable active projects in the selected storage', () => {
    render(
      <ThreadCreationHome
        accountScope="fixture:user-7"
        sources={[local]}
        projects={[
          project,
          { ...project, id: 'P2', name: '只读项目', access_role: 'Viewer' },
          { ...project, id: 'P3', name: '已归档项目', status: 'archived' },
          { ...project, id: 'P4', name: '团队项目', project_store: 'backend' },
        ]}
        locale="zh-CN"
      />
    )
    expect(screen.queryByRole('option', { name: '只读项目' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '已归档项目' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '团队项目' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('thread-home-project'), { target: { value: project.id } })
    fireEvent.click(screen.getByTestId('thread-home-create'))
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        form: expect.objectContaining({ project }),
      })
    )
  })

  it('keeps the selected cloud location visible and offers recovery after disconnect', () => {
    const connect = vi.fn()
    const view = render(
      <ThreadCreationHome
        accountScope="fixture:user-7"
        sources={[local, cloud]}
        projects={[]}
        locale="zh-CN"
        onConnectCloud={connect}
      />
    )
    expect(screen.getByTestId('thread-home-store')).toHaveValue('cloud')
    view.rerender(
      <ThreadCreationHome
        accountScope="fixture:user-7"
        sources={[local]}
        projects={[]}
        locale="zh-CN"
        onConnectCloud={connect}
      />
    )
    expect(screen.getByTestId('thread-home-store')).toHaveValue('cloud')
    expect(screen.getByTestId('thread-home-create')).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('所选保存位置当前不可用')
    fireEvent.click(screen.getByTestId('thread-home-connect'))
    expect(connect).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByTestId('thread-home-store'), { target: { value: 'local' } })
    expect(screen.getByTestId('thread-home-create')).toBeEnabled()
  })
})
