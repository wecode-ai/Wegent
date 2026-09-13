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

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@wegent/collaboration', () => ({
  CollaborationPlatformApp: ({ host }: { host: CollaborationPlatformHostAdapter }) => {
    capturedHost = host
    return (
      <button
        type="button"
        data-testid="open-resources"
        onClick={() =>
          host.navigate({
            platformView: 'resources',
            workspaceId: null,
            workspaceView: 'home',
            projectId: null,
            projectView: 'board',
            issueId: null,
          })
        }
      />
    )
  },
}))

jest.mock('@/features/collaboration/shared-api', () => ({
  createWebSharedWorkspaceApi: () => ({
    projects: {
      get: mockGetProject,
    },
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ getCurrentLanguage: () => 'zh-CN' }),
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
    localStorage.clear()
  })

  it('renders the platform spaces root and navigates resources through the thin host shell', () => {
    render(<CollaborationPage />)

    expect(capturedHost?.location).toEqual({
      platformView: 'spaces',
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
    expect(screen.getByTestId('collaboration-page-main')).toHaveClass('flex-1', 'overflow-hidden')

    fireEvent.click(screen.getByTestId('open-resources'))
    expect(mockPush).toHaveBeenCalledWith('/collaboration/resources')
  })

  it('maps a nested Workspace, Project and Issue URL into the shared location', () => {
    mockPathname = '/collaboration/workspaces/workspace%201/projects/project%252/issues/issue%253'
    mockSearchParams = new URLSearchParams('view=table')

    render(<CollaborationPage />)

    expect(capturedHost?.location).toEqual({
      platformView: 'spaces',
      workspaceId: 'workspace 1',
      workspaceView: 'home',
      projectId: 'project%2',
      projectView: 'table',
      issueId: 'issue%3',
    })
  })

  it.each(['automation', 'manage', 'files'] as const)(
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
        workspaceView: 'home',
        projectId: 'project/1',
        projectView: 'table',
        issueId: 'issue 1',
      })
    ).toBe(
      '/collaboration/workspaces/workspace%201/projects/project%2F1/issues/issue%201?view=table'
    )
  })
})
