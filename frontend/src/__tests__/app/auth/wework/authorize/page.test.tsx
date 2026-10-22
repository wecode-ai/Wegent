// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import Page from '@/app/auth/wework/authorize/page'
import { userApis, type WeworkAuthSessionActionResponse } from '@/apis/user'

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams('session_id=session-123'),
}))

jest.mock('@/features/common/UserContext', () => ({
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUser: () => ({ user: { user_name: 'alice' }, isLoading: false }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count: number }) => (options ? `${key}: ${options.count}` : key),
  }),
}))

jest.mock('@/apis/user', () => ({
  removeToken: jest.fn(),
  userApis: {
    approveWeworkAuthSession: jest.fn(),
    declineWeworkAuthSession: jest.fn(),
  },
}))

const approve = jest.mocked(userApis.approveWeworkAuthSession)
const decline = jest.mocked(userApis.declineWeworkAuthSession)

describe('Wework authorization auto-close', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(window, 'close').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
    jest.resetAllMocks()
  })

  it('starts the countdown only after approval succeeds and closes after three seconds', async () => {
    let resolveApproval!: (response: WeworkAuthSessionActionResponse) => void
    approve.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveApproval = resolve
        })
    )
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: 'auth.wework_authorize.approve' }))

    act(() => jest.advanceTimersByTime(5000))
    expect(window.close).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    await act(async () => resolveApproval({ status: 'approved' }))
    expect(approve).toHaveBeenCalledWith('session-123')
    for (const seconds of [3, 2, 1]) {
      expect(screen.getByRole('status')).toHaveTextContent(
        `auth.wework_authorize.close_countdown: ${seconds}`
      )
      expect(window.close).not.toHaveBeenCalled()
      act(() => jest.advanceTimersByTime(1000))
    }
    expect(window.close).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('auth.wework_authorize.close_manually')
    act(() => jest.advanceTimersByTime(5000))
    expect(window.close).toHaveBeenCalledTimes(1)
  })

  it.each(['failure', 'decline'])('does not close after %s', async outcome => {
    approve.mockRejectedValueOnce(new Error('Approval failed'))
    decline.mockResolvedValueOnce({ status: 'declined' })
    render(<Page />)
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: `auth.wework_authorize.${outcome === 'failure' ? 'approve' : 'cancel'}`,
        })
      )
    })
    act(() => jest.advanceTimersByTime(5000))
    expect(window.close).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('cancels the pending close when leaving the page', async () => {
    approve.mockResolvedValueOnce({ status: 'approved' })
    const { unmount } = render(<Page />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'auth.wework_authorize.approve' }))
    })
    unmount()
    act(() => jest.advanceTimersByTime(5000))
    expect(window.close).not.toHaveBeenCalled()
  })
})
