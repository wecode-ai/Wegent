// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type {
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
