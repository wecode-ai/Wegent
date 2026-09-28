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
let mockPathname = '/collaboration'
let mockSearchParams = new URLSearchParams()
let capturedHost: CollaborationPlatformHostAdapter | null = null
const mockGetProject = jest.fn()
const mockListGroups = jest.fn()

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
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
    t: (key: string) => key,
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
        renderModePicker: expect.any(Function),
        renderPrimaryAction: expect.any(Function),
        renderSelect: expect.any(Function),
      })
    )
    expect(screen.getByTestId('collaboration-page-main')).toHaveClass('flex-1', 'overflow-hidden')
    const theme = screen.getByTestId('collaboration-page-main').closest('.collaboration-theme')
    expect(theme).toHaveAttribute('data-theme', 'light')
    expect(theme).toHaveStyle({ display: 'contents', '--font-size-ui': '14px' })
    expect(screen.getByTestId('collaboration-context-sidebar')).toBeInTheDocument()
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

  it('removes an obsolete view from a canonical Project URL', async () => {
    mockPathname = '/collaboration/workspaces/workspace%201/projects/project%201'
    mockSearchParams = new URLSearchParams('view=automation')

    render(<CollaborationPage />)

    expect(capturedHost?.location.projectView).toBe('board')
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/collaboration/workspaces/workspace%201/projects/project%201'
      )
    )
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

  it.each(['manage', 'files'] as const)(
    'redirects a legacy Project %s URL into the canonical shared Workspace route',
    async view => {
      mockPathname = '/collaboration/project%201'
      mockSearchParams = new URLSearchParams(`view=${view}`)

      render(<CollaborationPage />)

      expect(capturedHost).toBeNull()
      expect(screen.getByText('正在进入协作空间…')).toBeInTheDocument()
      await waitFor(() =>
        expect(mockReplace).toHaveBeenCalledWith(
          `/collaboration/workspaces/workspace%201/projects/project%201?view=${view}`
        )
      )
    }
  )

  it('removes the legacy Project automation view from canonical routing', async () => {
    mockPathname = '/collaboration/project%201'
    mockSearchParams = new URLSearchParams('view=automation')

    render(<CollaborationPage />)

    expect(capturedHost).toBeNull()
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/collaboration/workspaces/workspace%201/projects/project%201'
      )
    )
  })

  it('falls back unknown legacy Project views to the canonical board', async () => {
    mockPathname = '/collaboration/project%201'
    mockSearchParams = new URLSearchParams('view=unknown')

    render(<CollaborationPage />)

    expect(capturedHost).toBeNull()
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/collaboration/workspaces/workspace%201/projects/project%201'
      )
    )
  })

  it('redirects a legacy Issue URL into the canonical shared Issue detail', async () => {
    mockPathname = '/collaboration/project%201/issues/issue%202'

    render(<CollaborationPage />)

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/collaboration/workspaces/workspace%201/projects/project%201/issues/issue%202'
      )
    )
  })

  it('returns to the spaces root when a legacy Project has no Workspace', async () => {
    mockPathname = '/collaboration/project%201'
    mockGetProject.mockResolvedValue({ id: 'project 1', workspace_id: null })

    render(<CollaborationPage />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/collaboration'))
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
    expect(collaborationLocationPath({ ...base, workspaceId: null, rootView: 'my-work' })).toBe(
      '/collaboration/my-work'
    )
    expect(collaborationLocationPath({ ...base, workspaceId: null, rootView: 'inbox' })).toBe(
      '/collaboration/inbox'
    )
    expect(collaborationLocationPath({ ...base, workspaceId: null, rootView: 'runs' })).toBe(
      '/collaboration/runs'
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

  it('opens My Work as a first-class collaboration root view', () => {
    mockPathname = '/collaboration/my-work'

    render(<CollaborationPage />)

    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockGetProject).not.toHaveBeenCalled()
    expect(capturedHost?.location).toEqual(
      expect.objectContaining({
        platformView: 'spaces',
        rootView: 'my-work',
        workspaceId: null,
      })
    )
  })

  it('redirects the removed global collaboration resources route to the collaboration home', async () => {
    mockPathname = '/collaboration/resources'

    render(<CollaborationPage />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/collaboration'))
    expect(mockGetProject).not.toHaveBeenCalled()
    expect(capturedHost?.location.platformView).toBe('spaces')
  })
})
