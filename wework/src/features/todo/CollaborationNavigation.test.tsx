import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CollaborationPrimaryNavigation,
  CollaborationManagementNavigation,
} from '../../../../packages/collaboration/src/platform/CollaborationPrimaryNavigation'
import { platformMessages } from '../../../../packages/collaboration/src/platform/platformMessages'
import { CollaborationPlatformNavigation } from '../../../../packages/collaboration/src/platform/CollaborationPlatformNavigation'
import type { CollaborationProject } from '@wegent/collaboration'
import type { CollaborationPlatformHostAdapter } from '@wegent/collaboration/platform'

afterEach(cleanup)

it.each(['local', 'cloud'] as const)(
  'retains local projects and defaults creation to %s',
  location => {
    const createProject = vi.fn()
    const host = {
      location: {},
      capabilities: {
        projectNavigation: 'projects',
        projectLocation: location,
        workspaceLocations: ['local', 'cloud'],
      },
      navigate: vi.fn(),
    } as unknown as CollaborationPlatformHostAdapter
    render(
      <CollaborationPlatformNavigation
        domain={location}
        host={host}
        messages={platformMessages['zh-CN']}
        workspaces={
          [
            { id: 'local-space', location: 'local', name: '本地空间', access_role: 'Owner' },
            ...(location === 'cloud'
              ? [
                  {
                    id: 'personal-space',
                    location: 'cloud',
                    name: '我的空间',
                    access_role: 'Owner',
                    is_system_default: true,
                  },
                ]
              : []),
          ] as never
        }
        workspaceNavigationContext={null}
        projects={
          [
            { id: 'local', name: '本机旧项目', project_store: 'local' },
            { id: 'cloud', name: '团队项目', project_store: 'backend' },
          ] as CollaborationProject[]
        }
        navigationIncomplete={false}
        onRetryNavigation={vi.fn()}
        canCreateWorkspace={true}
        onCreateWorkspace={vi.fn()}
        onCreateProject={vi.fn()}
        onCreateStandaloneProject={createProject}
        onArchiveProject={vi.fn()}
      />
    )
    expect(screen.getByText('本机旧项目')).toBeInTheDocument()
    expect(screen.getByText('团队项目')).toBeInTheDocument()
    expect(screen.getByText('协作')).toBeInTheDocument()
    expect(screen.getByText('个人分组')).toBeInTheDocument()
    expect(screen.getByTestId('collaboration-workspace-create')).toHaveAttribute(
      'aria-label',
      '创建分组'
    )
    expect(screen.queryByText('本地项目')).not.toBeInTheDocument()
    expect(screen.queryByText('远程项目')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-project-create-default')).not.toBeInTheDocument()
    const spaceId = location === 'cloud' ? 'personal-space' : 'local-space'
    fireEvent.click(screen.getByTestId(`collaboration-workspace-actions-${spaceId}`))
    expect(screen.queryByText('本地项目')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-workspace-nav-create-project'))
    expect(createProject).toHaveBeenCalledExactlyOnceWith(location)
    fireEvent.click(screen.getByTestId(`collaboration-workspace-actions-${spaceId}`))
    fireEvent.click(screen.getByTestId('collaboration-workspace-nav-settings'))
    expect(host.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: spaceId,
        collaborationDomain: location,
        workspaceView: 'settings',
        projectId: null,
      })
    )
  }
)

it('navigates three personal scopes without selecting a project and preserves management targets', () => {
  const navigate = vi.fn()
  const host = {
    location: { rootView: 'issues-created', workspaceId: null, projectId: null },
    navigate,
    renderPersonalHome: vi.fn(),
    renderIssueList: vi.fn(),
    createIndependentIssue: vi.fn(),
    templateStore: {},
    templateNavigation: true,
  } as unknown as CollaborationPlatformHostAdapter
  const props = { domain: 'local' as const, host, messages: platformMessages['zh-CN'] }
  render(
    <>
      <CollaborationPrimaryNavigation {...props} />
      <CollaborationManagementNavigation {...props} />
    </>
  )
  for (const scope of ['assigned', 'created', 'participating']) {
    fireEvent.click(screen.getByTestId(`collaboration-primary-issues-${scope}`))
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rootView: `issues-${scope}`,
        workspaceId: null,
        projectId: null,
        issueId: null,
      })
    )
  }
  expect(screen.getByTestId('collaboration-primary-issues-created')).toHaveAttribute(
    'aria-current',
    'page'
  )
  expect(screen.queryByTestId('collaboration-primary-stand-in')).not.toBeInTheDocument()
  const group = screen.getByRole('navigation', { name: '协作管理' })
  const home = screen.getByTestId('collaboration-primary-home')
  const create = screen.getByTestId('collaboration-primary-create-issue')
  const assigned = screen.getByTestId('collaboration-primary-issues-assigned')
  expect(screen.queryByText('我的事项')).not.toBeInTheDocument()
  expect(home.nextElementSibling).toBe(create)
  expect(create.nextElementSibling).toBe(assigned)
  expect(group.textContent).toMatch(/执行设备模板智能体协作小组/)
  expect(screen.getByTestId('collaboration-primary-agents')).not.toBeVisible()
  expect(screen.getByTestId('collaboration-management-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  fireEvent.click(screen.getByTestId('collaboration-management-toggle'))
  expect(screen.getByTestId('collaboration-primary-agents')).toBeVisible()
  fireEvent.click(screen.getByTestId('collaboration-primary-agents'))
  expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({ rootView: 'agents' }))
  fireEvent.click(screen.getByTestId('collaboration-management-toggle'))
  expect(screen.getByTestId('collaboration-management-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  expect(screen.getByTestId('collaboration-primary-agents')).not.toBeVisible()
  fireEvent.click(screen.getByTestId('collaboration-primary-create-issue'))
  expect(host.createIndependentIssue).toHaveBeenCalledOnce()
})
