// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type {
  CollaborationHostAdapter,
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
} from '@wegent/collaboration'

import {
  CollaborationPage,
  collaborationLocationPath,
} from '@/features/collaboration/CollaborationPage'

const mockPush = jest.fn()
const mockReplace = jest.fn()
let mockPathname = '/collaboration'
let mockSearchParams = new URLSearchParams()
let capturedHost: CollaborationPlatformHostAdapter | null = null
let capturedProjectHost: CollaborationHostAdapter | null = null

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@wegent/collaboration', () => ({
  CollaborationApp: ({ host }: { host: CollaborationHostAdapter }) => {
    capturedProjectHost = host
    return (
      <button
        type="button"
        data-testid="project-back"
        onClick={() =>
          host.navigate({
            projectId: null,
            issueId: null,
            view: 'board',
            rootView: 'home',
          })
        }
      />
    )
  },
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

jest.mock('@/features/collaboration/CollaborationProjectSection', () => ({
  CollaborationProjectSection: () => null,
}))

jest.mock('@/features/collaboration/shared-api', () => ({
  createWebSharedWorkspaceApi: () => ({}),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ getCurrentLanguage: () => 'zh-CN' }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/features/tasks/components/sidebar', () => ({
  CollapsedSidebarButtons: () => null,
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
  TaskSidebar: () => null,
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
    capturedProjectHost = null
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
    })

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
    expect(capturedProjectHost).toBeNull()
  })

  it.each(['automation', 'manage', 'files'] as const)(
    'routes a legacy Project %s URL to the mature project application',
    view => {
      mockPathname = '/collaboration/project%201'
      mockSearchParams = new URLSearchParams(`view=${view}`)

      render(<CollaborationPage />)

      expect(capturedHost).toBeNull()
      expect(capturedProjectHost?.location).toEqual({
        projectId: 'project 1',
        issueId: null,
        view,
        rootView: 'home',
      })
    }
  )

  it('falls back unknown legacy Project views to the mature board', () => {
    mockPathname = '/collaboration/project%201'
    mockSearchParams = new URLSearchParams('view=unknown')

    render(<CollaborationPage />)

    expect(capturedHost).toBeNull()
    expect(capturedProjectHost?.location).toEqual({
      projectId: 'project 1',
      issueId: null,
      view: 'board',
      rootView: 'home',
    })
  })

  it('routes a legacy Issue URL to the mature Issue detail and returns to spaces', () => {
    mockPathname = '/collaboration/project%201/issues/issue%202'

    render(<CollaborationPage />)

    expect(capturedProjectHost?.location).toEqual({
      projectId: 'project 1',
      issueId: 'issue 2',
      view: 'board',
      rootView: 'home',
    })

    fireEvent.click(screen.getByTestId('project-back'))
    expect(mockPush).toHaveBeenCalledWith('/collaboration')
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
