// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CollaborationHostAdapter } from '@wegent/collaboration'

import { CollaborationPage } from '@/features/collaboration/CollaborationPage'

const mockPush = jest.fn()
let mockSearchParams = new URLSearchParams()
let capturedHost: CollaborationHostAdapter | null = null

jest.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@wegent/collaboration', () => ({
  CollaborationApp: ({ host }: { host: CollaborationHostAdapter }) => {
    capturedHost = host
    return (
      <>
        <button
          type="button"
          data-testid="open-my-work"
          onClick={() =>
            host.navigate({
              projectId: null,
              issueId: null,
              view: 'board',
              rootView: 'my-work',
            })
          }
        />
        <button
          type="button"
          data-testid="back-home"
          onClick={() =>
            host.navigate({
              projectId: null,
              issueId: null,
              view: 'board',
              rootView: 'home',
            })
          }
        />
      </>
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

describe('CollaborationPage root routing', () => {
  beforeEach(() => {
    mockPush.mockReset()
    mockSearchParams = new URLSearchParams()
    capturedHost = null
    localStorage.clear()
  })

  it('opens My Work from the collaboration root', () => {
    render(<CollaborationPage />)

    expect(capturedHost?.location.rootView).toBe('home')
    fireEvent.click(screen.getByTestId('open-my-work'))
    expect(mockPush).toHaveBeenCalledWith('/collaboration?view=my-work')
  })

  it('recognizes the My Work URL and returns to the project home', () => {
    mockSearchParams = new URLSearchParams('view=my-work')

    render(<CollaborationPage />)

    expect(capturedHost?.location.rootView).toBe('my-work')
    fireEvent.click(screen.getByTestId('back-home'))
    expect(mockPush).toHaveBeenCalledWith('/collaboration')
  })
})
