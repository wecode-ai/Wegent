// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import SharedTaskPage from '@/app/shared/task/page'
import { openTaskRightPanel, registerTaskRightPanel } from '@/features/tasks/components/right-panel'

const mockGetPublicSharedTask = jest.fn()
const mockRouterPush = jest.fn()
const mockTranslate = (key: string) => key
let mockSearchParams = new URLSearchParams('token=shared-token')
let mockSessionToken: string | null = null
const mockMessageRenders: Array<{ token: string | null; session: string | null; content: string }> =
  []

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockMessageBubble({ msg }: { msg: { content: string } }) {
      mockMessageRenders.push({
        token: mockSearchParams.get('token'),
        session: mockSessionToken,
        content: msg.content,
      })
      return <div data-testid="shared-message-bubble">{msg.content}</div>
    },
}))

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockRouterPush }),
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getPublicSharedTask: (token: string) => mockGetPublicSharedTask(token),
  },
}))

jest.mock('@/apis/user', () => ({
  getToken: () => mockSessionToken,
  getSessionTokenSnapshot: () => mockSessionToken,
  SESSION_TOKEN_CHANGED_EVENT: 'wegent:session-token-changed',
  userApis: {
    getCurrentUser: jest.fn().mockResolvedValue({ user_name: 'Viewer' }),
  },
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/features/layout/TopNavigation', () => ({
  __esModule: true,
  default: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}))

jest.mock('@/features/layout/GithubStarButton', () => ({
  GithubStarButton: () => <div data-testid="github-star" />,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

jest.mock('@/utils/browserDetection', () => ({
  detectInAppBrowser: () => ({ isInAppBrowser: false }),
}))

registerTaskRightPanel('shared-test-panel', ({ embedded, onClose }) => (
  <div data-testid="shared-test-panel" data-embedded={String(embedded)}>
    <button type="button" data-testid="shared-test-panel-close" onClick={onClose}>
      close panel
    </button>
  </div>
))

describe('SharedTaskPage right panel', () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams('token=shared-token')
    mockSessionToken = null
    mockMessageRenders.length = 0
    mockGetPublicSharedTask.mockReset()
    mockRouterPush.mockReset()
    mockGetPublicSharedTask.mockResolvedValue({
      task_title: 'Shared task',
      sharer_name: 'Alice',
      sharer_id: 1,
      subtasks: [],
      created_at: '2026-08-31T00:00:00Z',
    })
  })

  it('opens and closes registered panels in the shared task view', async () => {
    render(<SharedTaskPage />)

    await screen.findByRole('heading', { name: 'Shared task' })
    const content = screen
      .getByRole('heading', { name: 'Shared task' })
      .closest('.custom-scrollbar')

    act(() => {
      openTaskRightPanel({
        panelType: 'shared-test-panel',
        panelProps: {},
      })
    })

    expect(screen.getByTestId('shared-task-right-panel')).toBeInTheDocument()
    expect(screen.getByTestId('shared-test-panel')).toHaveAttribute('data-embedded', 'true')
    expect(content).toHaveClass('lg:mr-[720px]')
    expect(content).not.toHaveClass('md:mr-[720px]')

    fireEvent.click(screen.getByTestId('shared-test-panel-close'))

    await waitFor(() => {
      expect(screen.queryByTestId('shared-task-right-panel')).not.toBeInTheDocument()
    })
    expect(content).not.toHaveClass('lg:mr-[720px]')
  })

  it('preserves the legacy URL when login is required instead of copying', async () => {
    mockGetPublicSharedTask.mockRejectedValue(Object.assign(new Error('legacy'), { status: 401 }))
    render(<SharedTaskPage />)
    await screen.findByRole('heading', { name: 'shared-task:legacy_login_required' })
    expect(screen.queryByTestId('shared-message-bubble')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('shared-task-access-action'))
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/login?redirect=${encodeURIComponent('/shared/task?token=shared-token')}`
    )
  })

  it('explains missing permission without offering automatic access', async () => {
    mockGetPublicSharedTask.mockRejectedValue(Object.assign(new Error('legacy'), { status: 403 }))
    render(<SharedTaskPage />)
    await screen.findByRole('heading', { name: 'shared-task:legacy_access_required' })
    expect(screen.getByText('shared-task:legacy_access_required_desc')).toBeInTheDocument()
    expect(screen.queryByTestId('shared-message-bubble')).not.toBeInTheDocument()
  })

  it('does not publish a late response from the previous share URL', async () => {
    let resolveOld!: (value: unknown) => void
    mockGetPublicSharedTask.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    const { rerender } = render(<SharedTaskPage />)
    mockSearchParams = new URLSearchParams('token=new-link')
    rerender(<SharedTaskPage />)
    await screen.findByRole('heading', { name: 'Shared task' })
    await act(async () => {
      resolveOld({
        task_title: 'Previous private task',
        sharer_name: 'Owner',
        sharer_id: 1,
        subtasks: [],
        created_at: '2026-08-31T00:00:00Z',
      })
    })
    expect(screen.queryByRole('heading', { name: 'Previous private task' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Shared task' })).toBeInTheDocument()
  })

  it.each(['link', 'session', 'logout'])(
    'never renders previous private content in a changed %s scope',
    async change => {
      mockSessionToken = 'authorized-session'
      mockGetPublicSharedTask.mockResolvedValueOnce({
        task_title: 'Previous private task',
        sharer_name: 'Owner',
        sharer_id: 1,
        subtasks: [
          {
            id: 1,
            role: 'USER',
            prompt: 'previous-private-body',
            status: 'COMPLETED',
            created_at: '2026-08-31T00:00:00Z',
          },
        ],
        created_at: '2026-08-31T00:00:00Z',
      })
      const { rerender } = render(<SharedTaskPage />)
      await screen.findByText('previous-private-body')
      mockMessageRenders.length = 0
      mockGetPublicSharedTask.mockRejectedValueOnce(
        Object.assign(new Error('denied in replacement scope'), { status: 403 })
      )
      if (change === 'link') mockSearchParams = new URLSearchParams('token=another-link')
      else mockSessionToken = change === 'logout' ? null : 'unauthorized-session'
      rerender(<SharedTaskPage />)
      await screen.findByRole('heading', { name: 'shared-task:legacy_access_required' })
      expect(mockMessageRenders).toEqual([])
      expect(screen.queryByText('previous-private-body')).not.toBeInTheDocument()
    }
  )

  it('does not reopen a previous attachment panel after loading another share', async () => {
    const { rerender } = render(<SharedTaskPage />)
    await screen.findByRole('heading', { name: 'Shared task' })
    act(() => {
      openTaskRightPanel({ panelType: 'shared-test-panel', panelProps: {} })
    })
    expect(screen.getByTestId('shared-test-panel')).toBeInTheDocument()
    mockSearchParams = new URLSearchParams('token=shared-token&view=detail')
    rerender(<SharedTaskPage />)
    expect(screen.getByTestId('shared-test-panel')).toBeInTheDocument()
    expect(mockGetPublicSharedTask).toHaveBeenCalledTimes(1)
    mockSearchParams = new URLSearchParams('token=another-link')
    rerender(<SharedTaskPage />)
    await waitFor(() => expect(mockGetPublicSharedTask).toHaveBeenCalledWith('another-link'))
    await screen.findByRole('heading', { name: 'Shared task' })
    expect(screen.queryByTestId('shared-test-panel')).not.toBeInTheDocument()
  })

  it.each(['account', 'logout', 'clear'])(
    'clears private content when another tab changes the session (%s)',
    async change => {
      mockSessionToken = 'authorized-session'
      mockGetPublicSharedTask.mockResolvedValueOnce({
        task_title: 'Private task',
        sharer_name: 'Owner',
        sharer_id: 1,
        subtasks: [
          {
            id: 1,
            role: 'USER',
            prompt: 'private-session-body',
            status: 'COMPLETED',
            created_at: '2026-08-31T00:00:00Z',
          },
        ],
        created_at: '2026-08-31T00:00:00Z',
      })
      render(<SharedTaskPage />)
      await screen.findByText('private-session-body')
      act(() => {
        openTaskRightPanel({ panelType: 'shared-test-panel', panelProps: {} })
      })
      expect(screen.getByTestId('shared-test-panel')).toBeInTheDocument()
      mockMessageRenders.length = 0
      mockGetPublicSharedTask.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { status: change === 'account' ? 403 : 401 })
      )
      act(() => {
        mockSessionToken = change === 'account' ? 'another-session' : null
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: change === 'clear' ? null : 'auth_token',
            newValue: mockSessionToken,
          })
        )
      })
      expect(screen.queryByText('private-session-body')).not.toBeInTheDocument()
      expect(screen.queryByTestId('shared-test-panel')).not.toBeInTheDocument()
      await screen.findByTestId('shared-task-access-action')
      expect(mockMessageRenders).toEqual([])
      expect(mockGetPublicSharedTask).toHaveBeenCalledTimes(2)
    }
  )
})
