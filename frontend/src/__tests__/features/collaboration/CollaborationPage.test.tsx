// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
} from '@wegent/collaboration'

import { CollaborationPage } from '@/features/collaboration/CollaborationPage'
import { collaborationLocationPath } from '@/features/collaboration/routes'

const mockPush = jest.fn()
const mockReplace = jest.fn()
const mockRouter = { push: mockPush, replace: mockReplace }
const mockT = (key: string) => key
let mockPathname = '/collaboration'
let mockSearchParams = new URLSearchParams()
let capturedHost: CollaborationPlatformHostAdapter | null = null
const mockGetProject = jest.fn()
const mockListGroups = jest.fn()

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@wegent/collaboration', () => ({
  CollaborationPlatformApp: ({
    host,
    renderShell,
  }: {
    host: CollaborationPlatformHostAdapter
    renderShell?: (shell: { main: React.ReactNode; sidebar: React.ReactNode }) => React.ReactNode
  }) => {
    capturedHost = host
    return renderShell?.({
      main: <div data-testid="shared-collaboration-main" />,
      sidebar: <div data-testid="shared-collaboration-sidebar">spaces</div>,
    })
  },
}))

jest.mock(
  '@/features/layout/TopNavigation',
  () =>
    function MockTopNavigation() {
      return <div data-testid="top-navigation" />
    }
)

jest.mock('@/features/layout/components/UserFloatingMenu', () => ({
  UserFloatingMenu: () => <div data-testid="user-floating-menu" />,
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      id: 7,
      user_name: 'current-user',
    },
  }),
}))

jest.mock('@/apis/groups', () => ({
  listGroups: (...args: unknown[]) => mockListGroups(...args),
}))

jest.mock('@/features/collaboration/shared-api', () => ({
  createWebSharedWorkspaceApi: () => ({
    projects: {
      get: mockGetProject,
    },
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    getCurrentLanguage: () => 'zh-CN',
    t: mockT,
  }),
}))

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

describe('CollaborationPage platform routing', () => {
  beforeEach(() => {
    mockPush.mockReset()
    mockReplace.mockReset()
    mockPathname = '/collaboration'
    mockSearchParams = new URLSearchParams()
    capturedHost = null
    mockGetProject.mockReset()
    mockGetProject.mockResolvedValue({
      id: 'project 1',
      workspace_id: 'workspace 1',
    })
    mockListGroups.mockReset()
    mockListGroups.mockReturnValue(new Promise(() => undefined))
    localStorage.clear()
  })

  it('preserves the comment focus request when resolving an Issue notification URL', async () => {
    mockPathname = '/collaboration/project%201/issues/ISSUE-1'
    mockSearchParams = new URLSearchParams({ commentId: 'comment/1', focusRequest: 'click-2' })

    render(<CollaborationPage />)

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/collaboration/workspaces/workspace%201/projects/project%201/issues/ISSUE-1?commentId=comment%2F1&focusRequest=click-2'
      )
    )
  })

  it('keeps a rejected Issue target visible with a local error instead of leaving the Issue', async () => {
    mockPathname = '/collaboration/project%201/issues/ISSUE-1'
    mockGetProject.mockRejectedValueOnce(new Error('Forbidden'))

    render(<CollaborationPage />)

    expect(await screen.findByTestId('collaboration-error')).toHaveTextContent('Forbidden')
    expect(screen.getByTestId('collaboration-route-retry')).toBeEnabled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('retries the same Issue and preserves its requested comment after recovery', async () => {
    mockPathname = '/collaboration/project%201/issues/ISSUE-1'
    mockSearchParams = new URLSearchParams({ commentId: 'comment/1', focusRequest: 'click-2' })
    mockGetProject.mockRejectedValueOnce(new Error('Forbidden'))

    render(<CollaborationPage />)

    await screen.findByTestId('collaboration-error')
    fireEvent.click(screen.getByTestId('collaboration-route-retry'))

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/collaboration/workspaces/workspace%201/projects/project%201/issues/ISSUE-1?commentId=comment%2F1&focusRequest=click-2'
      )
    )
    expect(mockGetProject).toHaveBeenNthCalledWith(1, 'project 1')
    expect(mockGetProject).toHaveBeenNthCalledWith(2, 'project 1')
    expect(mockGetProject).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('collaboration-error')).not.toBeInTheDocument()
  })

  it('hides the previous Project error while a new target is resolving', async () => {
    mockPathname = '/collaboration/project%201/issues/ISSUE-1'
    mockGetProject.mockRejectedValueOnce(new Error('Forbidden'))
    const { rerender } = render(<CollaborationPage />)
    await screen.findByTestId('collaboration-error')

    mockPathname = '/collaboration/project%202/issues/ISSUE-2'
    mockGetProject.mockReturnValueOnce(new Promise(() => undefined))
    rerender(<CollaborationPage />)

    expect(screen.queryByTestId('collaboration-error')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('collaboration_route.loading')
    expect(mockGetProject).toHaveBeenLastCalledWith('project 2')
  })

  it('passes the requested comment to the shared Issue host', () => {
    mockPathname = '/collaboration/workspaces/workspace-1/projects/project-1/issues/ISSUE-1'
    mockSearchParams = new URLSearchParams({ commentId: 'comment-1', focusRequest: 'click-1' })

    render(<CollaborationPage />)

    expect(capturedHost?.location).toEqual(
      expect.objectContaining({
        issueId: 'ISSUE-1',
        commentId: 'comment-1',
        focusRequest: 'click-1',
      })
    )
  })

  it('renders the platform spaces root through the thin host shell', () => {
    render(<CollaborationPage />)

    expect(capturedHost?.location).toEqual({
      platformView: 'spaces',
      rootView: 'home',
      workspaceId: null,
      workspaceView: 'home',
      projectId: null,
      projectView: 'board',
      issueId: null,
    })
    expect(capturedHost?.capabilities).toEqual({
      automation: true,
      dingtalkAitable: false,
      projectLocation: 'cloud',
      workspaceLocations: ['cloud'],
      sidebarPresentation: 'context',
    })
    expect(capturedHost?.currentUser).toEqual({
      id: 7,
      name: 'current-user',
    })
    expect(capturedHost?.projectAgentConfiguration).toEqual(
      expect.objectContaining({
        renderDialog: expect.any(Function),
      })
    )
    expect(screen.getByTestId('collaboration-page-main')).toHaveClass('flex-1', 'overflow-hidden')
    const theme = screen.getByTestId('collaboration-page-main').closest('.collaboration-theme')
    expect(theme).toHaveAttribute('data-theme', 'light')
    expect(theme).toHaveStyle({ display: 'contents', '--font-size-ui': '14px' })
    expect(screen.getByTestId('collaboration-context-sidebar')).toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-nav-my-work')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-nav-runs')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-sidebar-system-navigation')).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-context-sidebar')).toContainElement(
      screen.getByTestId('shared-collaboration-sidebar')
    )
  })

  it('opens the selected execution environment in device management', () => {
    render(<CollaborationPage />)

    capturedHost?.manageResource?.('environments', 'device/21')

    expect(mockPush).toHaveBeenCalledWith('/devices?deviceId=device%2F21')
  })

  it.each([
    ['agents', '/collaboration/agents'],
    ['teams', '/collaboration/teams'],
    ['devices', '/collaboration/devices'],
  ])('opens the cloud %s resource center from the Web collaboration sidebar', (kind, path) => {
    render(<CollaborationPage />)

    fireEvent.click(screen.getByTestId(`collaboration-nav-${kind}`))

    expect(mockPush).toHaveBeenCalledWith(path)
  })

  it('opens device registration from execution environment management', () => {
    render(<CollaborationPage />)

    capturedHost?.manageResource?.('environments')

    expect(mockPush).toHaveBeenCalledWith('/devices?register=1')
  })

  it('maps a nested Workspace, Project and Issue URL into the shared location', () => {
    mockPathname = '/collaboration/workspaces/workspace%201/projects/project%252/issues/issue%253'
    mockSearchParams = new URLSearchParams('view=table')

    render(<CollaborationPage />)

    expect(capturedHost?.location).toEqual({
      platformView: 'spaces',
      rootView: 'home',
      workspaceId: 'workspace 1',
      workspaceView: 'home',
      projectId: 'project%2',
      projectView: 'table',
      issueId: 'issue%3',
    })
  })

  it('maps the Workspace collaboration participants URL into the shared location', () => {
    mockPathname = '/collaboration/workspaces/workspace%201/participants'

    render(<CollaborationPage />)

    expect(capturedHost?.location).toEqual({
      platformView: 'spaces',
      rootView: 'home',
      workspaceId: 'workspace 1',
      workspaceView: 'collaboration-participants',
      projectId: null,
      projectView: 'board',
      issueId: null,
    })
  })

  it.each(['calendar', 'gantt'] as const)(
    'preserves the %s view when switching, reloading and opening an Issue',
    view => {
      const projectPath = '/collaboration/workspaces/workspace%201/projects/project%201'
      mockPathname = projectPath
      const { rerender } = render(<CollaborationPage />)

      capturedHost?.navigate({ ...capturedHost.location, projectView: view })
      expect(mockPush).toHaveBeenCalledWith(`${projectPath}?view=${view}`)

      mockSearchParams = new URLSearchParams(`view=${view}`)
      rerender(<CollaborationPage />)

      expect(capturedHost?.location.projectView).toBe(view)
      expect(mockReplace).not.toHaveBeenCalled()

      mockPathname = `${projectPath}/issues/issue%201`
      rerender(<CollaborationPage />)

      expect(capturedHost?.location).toEqual(
        expect.objectContaining({ projectView: view, issueId: 'issue 1' })
      )
      expect(collaborationLocationPath(capturedHost!.location)).toBe(
        `${projectPath}/issues/issue%201?view=${view}`
      )
      expect(mockReplace).not.toHaveBeenCalled()
    }
  )

  it('preserves the active settings section across cached project navigation and reload', () => {
    const projectPath = '/collaboration/workspaces/workspace%201/projects/project%201'
    mockPathname = projectPath
    mockSearchParams = new URLSearchParams('view=manage&section=groups')
    const { rerender } = render(<CollaborationPage />)
    expect(capturedHost?.location.projectSettingsSection).toBe('groups')
    capturedHost?.navigate({ ...capturedHost.location, projectId: 'project 2' })
    expect(mockPush).toHaveBeenCalledWith(
      '/collaboration/workspaces/workspace%201/projects/project%202?view=manage&section=groups'
    )
    mockPathname = '/collaboration/workspaces/workspace%201/projects/project%202'
    rerender(<CollaborationPage />)
    expect(capturedHost?.location.projectSettingsSection).toBe('groups')
    capturedHost?.navigate({ ...capturedHost.location, projectView: 'board' })
    expect(mockPush).toHaveBeenLastCalledWith(mockPathname)
  })

  it.each(['view=manage&section=invalid', 'view=board&section=groups'])(
    'ignores an inapplicable settings section: %s',
    query => {
      mockSearchParams = new URLSearchParams(query)
      render(<CollaborationPage />)
      expect(capturedHost?.location.projectSettingsSection).toBeUndefined()
    }
  )

  it('delegates URL view resolution to the shared project shell', () => {
    mockPathname = '/collaboration/workspaces/workspace%201/projects/project%201'
    mockSearchParams = new URLSearchParams('view=automation')

    render(<CollaborationPage />)

    expect(capturedHost?.location.projectView).toBe('automation')
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('opens an Issue drawer with native shallow history inside the current Project', () => {
    mockPathname = '/collaboration/workspaces/workspace%201/projects/project%201'
    const pushState = jest.spyOn(window.history, 'pushState').mockImplementation(() => undefined)

    render(<CollaborationPage />)

    capturedHost?.navigate({
      ...capturedHost.location,
      issueId: 'issue 1',
    })

    expect(pushState).toHaveBeenCalledWith(
      null,
      '',
      '/collaboration/workspaces/workspace%201/projects/project%201/issues/issue%201'
    )
    expect(mockPush).not.toHaveBeenCalled()
    pushState.mockRestore()
  })

  it.each(['manage', 'files', 'calendar', 'gantt', 'automation', 'unknown'] as const)(
    'redirects a legacy Project %s URL into the canonical shared Workspace route',
    async view => {
      mockPathname = '/collaboration/project%201'
      mockSearchParams = new URLSearchParams(`view=${view}`)

      render(<CollaborationPage />)

      expect(capturedHost).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent('collaboration_route.loading')
      await waitFor(() =>
        expect(mockReplace).toHaveBeenCalledWith(
          `/collaboration/workspaces/workspace%201/projects/project%201?view=${view}`
        )
      )
    }
  )

  it('redirects a legacy Issue URL into the canonical shared Issue detail', async () => {
    mockPathname = '/collaboration/project%201/issues/issue%202'

    render(<CollaborationPage />)

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/collaboration/workspaces/workspace%201/projects/project%201/issues/issue%202'
      )
    )
  })

  it('keeps a missing Workspace failure scoped to the requested Project', async () => {
    mockPathname = '/collaboration/project%201'
    mockGetProject.mockResolvedValue({ id: 'project 1', workspace_id: null })

    render(<CollaborationPage />)

    expect(await screen.findByTestId('collaboration-error')).toHaveTextContent(
      'collaboration_route.workspace_missing'
    )
    expect(screen.getByTestId('collaboration-route-retry')).toBeEnabled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('keeps path construction centralized for every shared hierarchy level', () => {
    const base: CollaborationPlatformLocation = {
      platformView: 'spaces',
      workspaceId: 'workspace 1',
      workspaceView: 'members',
      projectId: null,
      projectView: 'board',
      issueId: null,
    }

    expect(collaborationLocationPath(base)).toBe('/collaboration/workspaces/workspace%201/members')
    expect(
      collaborationLocationPath({
        ...base,
        workspaceView: 'collaboration-participants',
      })
    ).toBe('/collaboration/workspaces/workspace%201/participants')
    expect(
      collaborationLocationPath({
        ...base,
        workspaceView: 'home',
        projectId: 'project/1',
        projectView: 'table',
        issueId: 'issue 1',
      })
    ).toBe(
      '/collaboration/workspaces/workspace%201/projects/project%2F1/issues/issue%201?view=table'
    )
    expect(collaborationLocationPath({ ...base, workspaceId: null, rootView: 'home' })).toBe(
      '/collaboration'
    )
    expect(collaborationLocationPath({ ...base, workspaceId: null, rootView: 'stand-in' })).toBe(
      '/collaboration'
    )
    expect(collaborationLocationPath({ ...base, workspaceId: null, rootView: 'inbox' })).toBe(
      '/collaboration/inbox'
    )
  })

  it.each(['agents', 'teams', 'devices'] as const)(
    'round-trips the %s resource root without treating it as a legacy project',
    rootView => {
      mockPathname = `/collaboration/${rootView}`

      render(<CollaborationPage />)

      expect(mockReplace).not.toHaveBeenCalled()
      expect(mockGetProject).not.toHaveBeenCalled()
      expect(capturedHost?.location).toEqual(
        expect.objectContaining({ rootView, workspaceId: null, projectId: null })
      )
      expect(collaborationLocationPath(capturedHost!.location)).toBe(mockPathname)
    }
  )

  it.each(['resources', 'my-work', 'runs'])(
    'redirects removed %s routes to collaboration home',
    async module => {
      mockPathname = `/collaboration/${module}`

      render(<CollaborationPage />)

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/collaboration'))
      expect(mockGetProject).not.toHaveBeenCalled()
      expect(capturedHost?.location.platformView).toBe('spaces')
    }
  )
})
