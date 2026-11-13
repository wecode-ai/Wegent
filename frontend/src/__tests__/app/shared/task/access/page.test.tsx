import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TaskAccessPage from '@/app/shared/task/access/page'

const mockGetInfo = jest.fn()
const mockJoin = jest.fn()
const mockPush = jest.fn()
const mockTranslate = (key: string) => key
let mockToken: string | null = 'session'
let mockSearch = new URLSearchParams('token=approval-token')
const info = {
  resource_type: 'Task',
  resource_id: 42,
  resource_name: 'Private task',
  owner_user_id: 1,
  owner_user_name: 'Owner',
  require_approval: true,
  default_role: 'Reporter',
  is_expired: false,
}

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: mockPush }),
}))
jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getTaskAccessShareInfo: (token: string) => mockGetInfo(token),
    joinTaskAccessShare: (token: string) => mockJoin(token),
  },
}))
jest.mock('@/apis/user', () => ({
  getSessionTokenSnapshot: () => mockToken,
  SESSION_TOKEN_CHANGED_EVENT: 'wegent:session-token-changed',
}))
jest.mock('@/features/layout/TopNavigation', () => ({
  __esModule: true,
  default: () => <header />,
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

describe('Task access share page', () => {
  beforeEach(() => {
    mockToken = 'session'
    mockSearch = new URLSearchParams('token=approval-token')
    mockPush.mockReset()
    mockGetInfo.mockReset().mockResolvedValue(info)
    mockJoin.mockReset().mockResolvedValue({
      status: 'pending',
      resource_type: 'Task',
      resource_id: 42,
    })
  })

  it('previews metadata anonymously and preserves the URL through login', async () => {
    mockToken = null
    render(<TaskAccessPage />)
    await screen.findByRole('heading', { name: 'Private task' })
    expect(screen.getByText('access_approval_notice')).toBeInTheDocument()
    expect(mockJoin).not.toHaveBeenCalled()
    expect(screen.queryByTestId('task-access-request')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-access-login'))
    expect(mockPush).toHaveBeenCalledWith(
      `/login?redirect=${encodeURIComponent('/shared/task/access?token=approval-token')}`
    )
  })

  it('requests approval without navigating to task content', async () => {
    render(<TaskAccessPage />)
    fireEvent.click(await screen.findByTestId('task-access-request'))
    await screen.findByTestId('task-access-pending')
    expect(mockJoin).toHaveBeenCalledWith('approval-token')
    expect(mockPush).not.toHaveBeenCalled()
    mockJoin.mockRejectedValueOnce(
      Object.assign(new Error('Request already pending approval'), { status: 400 })
    )
    fireEvent.click(screen.getByTestId('task-access-request'))
    await waitFor(() => expect(mockJoin).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('task-access-request')).not.toBeDisabled())
    expect(screen.getByTestId('task-access-pending')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it.each([null, 99])('opens only the approved task or its recorded copy (%s)', async copy => {
    mockJoin.mockResolvedValue({
      status: 'approved',
      resource_type: 'Task',
      resource_id: 42,
      copied_resource_id: copy,
    })
    render(<TaskAccessPage />)
    fireEvent.click(await screen.findByTestId('task-access-request'))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/chat?taskId=${copy || 42}`))
  })

  it.each(['Already have access to this resource', 'Cannot join your own resource'])(
    'opens an already authorized task: %s',
    async message => {
      mockJoin.mockRejectedValue(Object.assign(new Error(message), { status: 400 }))
      render(<TaskAccessPage />)
      fireEvent.click(await screen.findByTestId('task-access-request'))
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/chat?taskId=42'))
    }
  )

  it.each([401, 403])(
    'keeps the legacy permission boundary on metadata failure %s',
    async status => {
      mockGetInfo.mockRejectedValue(Object.assign(new Error('denied'), { status }))
      render(<TaskAccessPage />)
      await screen.findByText(status === 401 ? 'legacy_login_required' : 'legacy_access_required')
      expect(screen.queryByRole('heading', { name: 'Private task' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('task-access-request')).not.toBeInTheDocument()
      expect(mockJoin).not.toHaveBeenCalled()
      if (status === 401) expect(screen.getByTestId('task-access-login')).toBeInTheDocument()
    }
  )

  it('does not redirect or grant access when the join endpoint denies access', async () => {
    mockJoin.mockRejectedValue(Object.assign(new Error('denied'), { status: 403 }))
    render(<TaskAccessPage />)
    fireEvent.click(await screen.findByTestId('task-access-request'))
    await screen.findByText('legacy_access_required')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it.each([
    { ...info, resource_type: 'Team' },
    { ...info, is_expired: true },
  ])('rejects unrelated or expired share metadata', async data => {
    mockGetInfo.mockResolvedValue(data)
    render(<TaskAccessPage />)
    await screen.findByText('error_invalid_link')
    expect(screen.queryByTestId('task-access-request')).not.toBeInTheDocument()
    expect(mockJoin).not.toHaveBeenCalled()
  })

  it('rejects a missing token without requesting metadata', async () => {
    mockSearch = new URLSearchParams()
    render(<TaskAccessPage />)
    await screen.findByText('error_invalid_link')
    expect(mockGetInfo).not.toHaveBeenCalled()
  })

  it('can retry a failed metadata request without treating it as an invalid link', async () => {
    mockGetInfo.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
    render(<TaskAccessPage />)
    await screen.findByText('error_load_failed')
    fireEvent.click(screen.getByTestId('task-access-retry'))
    await screen.findByRole('heading', { name: 'Private task' })
    expect(mockGetInfo).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('error_load_failed')).not.toBeInTheDocument()
    expect(mockJoin).not.toHaveBeenCalled()
  })

  it('ignores late metadata after the share URL changes', async () => {
    let resolveOld!: (value: unknown) => void
    mockGetInfo.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    const { rerender } = render(<TaskAccessPage />)
    mockSearch = new URLSearchParams('token=second-token')
    mockGetInfo.mockResolvedValue({ ...info, resource_name: 'Second task' })
    rerender(<TaskAccessPage />)
    await screen.findByRole('heading', { name: 'Second task' })
    await act(async () => {
      resolveOld(info)
    })
    expect(screen.queryByRole('heading', { name: 'Private task' })).not.toBeInTheDocument()
  })

  it('ignores a late approval result after the session changes', async () => {
    let resolveJoin!: (value: unknown) => void
    mockJoin.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveJoin = resolve
        })
    )
    const { rerender } = render(<TaskAccessPage />)
    fireEvent.click(await screen.findByTestId('task-access-request'))
    mockToken = 'another-session'
    rerender(<TaskAccessPage />)
    await screen.findByTestId('task-access-request')
    await act(async () => {
      resolveJoin({ status: 'approved', resource_type: 'Task', resource_id: 42 })
    })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('does not navigate after leaving the access page during a request', async () => {
    let resolveJoin!: (value: unknown) => void
    mockJoin.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveJoin = resolve
        })
    )
    const { unmount } = render(<TaskAccessPage />)
    fireEvent.click(await screen.findByTestId('task-access-request'))
    unmount()
    await act(async () => {
      resolveJoin({ status: 'approved', resource_type: 'Task', resource_id: 42 })
    })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('ignores approval from the previous account after another tab logs out', async () => {
    let resolveJoin!: (value: unknown) => void
    mockJoin.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveJoin = resolve
        })
    )
    render(<TaskAccessPage />)
    fireEvent.click(await screen.findByTestId('task-access-request'))
    act(() => {
      mockToken = null
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: null }))
    })
    await act(async () => {
      resolveJoin({ status: 'approved', resource_type: 'Task', resource_id: 42 })
    })
    expect(mockPush).not.toHaveBeenCalled()
    expect(screen.queryByTestId('task-access-request')).not.toBeInTheDocument()
    expect(await screen.findByTestId('task-access-login')).toBeInTheDocument()
  })
})
