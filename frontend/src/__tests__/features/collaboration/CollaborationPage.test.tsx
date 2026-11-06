// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
} from '@wegent/collaboration'

import { CollaborationTemplateStore, templateIdentity } from '@wegent/collaboration/templates'

import { CollaborationPage } from '@/features/collaboration/CollaborationPage'
import { collaborationLocationPath } from '@/features/collaboration/routes'
import { apiClient } from '@/apis/client'

const mockPush = jest.fn()
const mockReplace = jest.fn()
let mockPathname = '/collaboration'
let mockSearchParams = new URLSearchParams()
let capturedHost: CollaborationPlatformHostAdapter | null = null
let capturedApi: unknown
let mockAccountScope = 'backend:auth-generation-1'
let mockUser: { id: number; user_name: string } | null = { id: 7, user_name: 'current-user' }
const mockGetProject = jest.fn()
const mockListGroups = jest.fn()
const mockCreateProjectChatClient = jest.fn(() => ({ dispose: jest.fn() }))
const mockCreateCloudRuntimeIpcClient = jest.fn(() => ({}))
const mockCreateRuntimeConversationClient = jest.fn(() => ({ dispose: jest.fn() }))
jest.spyOn(apiClient, 'getCacheScope').mockImplementation(() => mockAccountScope)
jest.mock('@wegent/chat-core', () => ({
  ...jest.requireActual('@wegent/chat-core'),
  createProjectChatClient: () => mockCreateProjectChatClient(),
  createCloudRuntimeIpcClient: () => mockCreateCloudRuntimeIpcClient(),
  createRuntimeConversationClient: () => mockCreateRuntimeConversationClient(),
}))
let mockTemplateStore: CollaborationTemplateStore | null = null
let mockUserLoading = false
jest.mock('@/features/resource-library/useCollaborationTemplates', () => ({
  useCollaborationTemplates: () => mockTemplateStore,
}))

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@wegent/collaboration', () => ({
  CollaborationPlatformApp: ({
    api,
    host,
    renderShell,
  }: {
    api: unknown
    host: CollaborationPlatformHostAdapter
    renderShell?: (shell: { main: React.ReactNode; sidebar: React.ReactNode }) => React.ReactNode
  }) => {
    capturedApi = api
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
    isLoading: mockUserLoading,
    user: mockUser,
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
    mockUserLoading = false
    mockAccountScope = 'backend:auth-generation-1'
    mockUser = { id: 7, user_name: 'current-user' }
    mockCreateProjectChatClient.mockClear()
    mockCreateCloudRuntimeIpcClient.mockClear()
    mockCreateRuntimeConversationClient.mockClear()
    mockTemplateStore = null
    mockPush.mockReset()
    mockReplace.mockReset()
    mockPathname = '/collaboration'
    mockSearchParams = new URLSearchParams()
    capturedHost = null
    capturedApi = null
    mockGetProject.mockReset()
    mockGetProject.mockResolvedValue({
      id: 'project 1',
      workspace_id: 'workspace 1',
    })
    mockListGroups.mockReset()
    mockListGroups.mockReturnValue(new Promise(() => undefined))
    localStorage.clear()
  })

  it('waits for the authenticated owner before mounting the scoped workbench', () => {
    mockUserLoading = true
    mockUser = null
    const view = render(<CollaborationPage />)
    expect(screen.queryByTestId('shared-collaboration-main')).not.toBeInTheDocument()
    expect(capturedHost).toBeNull()
    expect(screen.getByTestId('top-navigation')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-back-to-workbench'))
    expect(mockPush).toHaveBeenCalledWith('/chat')
    mockUserLoading = false
    mockUser = { id: 7, user_name: 'current-user' }
    view.rerender(<CollaborationPage />)
    expect(screen.getByTestId('shared-collaboration-main')).toBeInTheDocument()
    expect(capturedHost?.currentUser?.id).toBe(7)
  })

  it('renders the platform spaces root through the thin host shell', () => {
    render(<CollaborationPage />)

    expect(capturedHost?.accountScope).toBe(mockAccountScope)
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

  it('keeps the account scope and API clients stable when the user profile arrives or refreshes', () => {
    mockUser = null
    mockUserLoading = true
    const { rerender } = render(<CollaborationPage />)
    const originalActivity = mockCreateProjectChatClient.mock.results[0].value
    const originalRuntime = mockCreateRuntimeConversationClient.mock.results[0].value
    expect(capturedHost).toBeNull()

    mockUserLoading = false
    mockUser = { id: 7, user_name: 'current-user' }
    rerender(<CollaborationPage />)
    const originalApi = capturedApi
    expect(capturedHost?.accountScope).toBe(mockAccountScope)
    expect(capturedHost?.currentUser).toEqual({ id: 7, name: 'current-user' })

    for (const user_name of ['current-user', 'updated profile']) {
      mockUser = { id: 7, user_name }
      rerender(<CollaborationPage />)
      expect(capturedHost?.accountScope).toBe(mockAccountScope)
      expect(capturedHost?.currentUser).toEqual({ id: 7, name: user_name })
      expect(capturedApi).toBe(originalApi)
    }

    expect(mockCreateProjectChatClient).toHaveBeenCalledTimes(1)
    expect(mockCreateCloudRuntimeIpcClient).toHaveBeenCalledTimes(1)
    expect(mockCreateRuntimeConversationClient).toHaveBeenCalledTimes(1)
    expect(originalActivity.dispose).not.toHaveBeenCalled()
    expect(originalRuntime.dispose).not.toHaveBeenCalled()
  })

  it.each(['backend:auth-generation-2', 'other-backend:auth-generation-1'])(
    'replaces and disposes API clients when the account scope changes to %s',
    nextScope => {
      const { rerender, unmount } = render(<CollaborationPage />)
      const originalApi = capturedApi
      const originalActivity = mockCreateProjectChatClient.mock.results[0].value
      const originalRuntime = mockCreateRuntimeConversationClient.mock.results[0].value

      mockAccountScope = nextScope
      rerender(<CollaborationPage />)
      expect(capturedHost?.accountScope).toBe(nextScope)
      expect(capturedApi).not.toBe(originalApi)
      expect(mockCreateProjectChatClient).toHaveBeenCalledTimes(2)
      expect(mockCreateCloudRuntimeIpcClient).toHaveBeenCalledTimes(2)
      expect(mockCreateRuntimeConversationClient).toHaveBeenCalledTimes(2)
      expect(originalActivity.dispose).toHaveBeenCalledTimes(1)
      expect(originalRuntime.dispose).toHaveBeenCalledTimes(1)

      const currentActivity = mockCreateProjectChatClient.mock.results[1].value
      const currentRuntime = mockCreateRuntimeConversationClient.mock.results[1].value
      expect(currentActivity.dispose).not.toHaveBeenCalled()
      expect(currentRuntime.dispose).not.toHaveBeenCalled()
      unmount()
      expect(currentActivity.dispose).toHaveBeenCalledTimes(1)
      expect(currentRuntime.dispose).toHaveBeenCalledTimes(1)
    }
  )

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
      expect(screen.getByText('正在进入协作空间…')).toBeInTheDocument()
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
  it('resolves the marketplace template in the current account and consumes its URL request', async () => {
    mockTemplateStore = new CollaborationTemplateStore({
      scope: 'web-7',
      ownerId: 7,
      persistence: { read: async () => [], write: async () => {} },
    })
    const record = mockTemplateStore.getSnapshot().records[0]
    mockSearchParams = new URLSearchParams({ template: templateIdentity(record) })
    render(<CollaborationPage />)
    await waitFor(() =>
      expect(capturedHost?.projectTemplateRequest?.document).toEqual(record.document)
    )
    capturedHost!.projectTemplateRequest!.onHandled()
    expect(mockReplace).toHaveBeenCalledWith('/collaboration', { scroll: false })
  })

  it('allows retry when the selected template cannot be loaded', async () => {
    mockTemplateStore = new CollaborationTemplateStore({
      scope: 'web-7',
      ownerId: 7,
      persistence: { read: async () => [], write: async () => {} },
    })
    const record = mockTemplateStore.getSnapshot().records[0]
    jest.spyOn(mockTemplateStore, 'load').mockRejectedValueOnce(new Error('storage failure'))
    mockSearchParams = new URLSearchParams({ template: templateIdentity(record) })
    render(<CollaborationPage />)
    fireEvent.click(await screen.findByTestId('template-request-retry'))
    await waitFor(() =>
      expect(capturedHost?.projectTemplateRequest?.document).toEqual(record.document)
    )
    expect(screen.queryByTestId('template-request-retry')).not.toBeInTheDocument()
  })
})
