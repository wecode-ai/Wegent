// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'

import Page from '@/app/auth/oauth/authorize/page'
import { OAuthAuthorizationRequest, oauthAuthorizationApis } from '@/apis/oauthProvider'
import { POST_LOGIN_REDIRECT_KEY } from '@/features/login/constants'

const mockReplace = jest.fn()
const mockTranslate = (key: string) => key
let mockRequestId = 'request-123'
let mockUserState: {
  user: { user_name: string } | null
  isLoading: boolean
} = {
  user: { user_name: 'alice' },
  isLoading: false,
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(`request_id=${mockRequestId}`),
}))

jest.mock('@/features/common/UserContext', () => ({
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUser: () => mockUserState,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

jest.mock('@/apis/oauthProvider', () => ({
  oauthAuthorizationApis: {
    getRequest: jest.fn(),
    approve: jest.fn(),
    deny: jest.fn(),
  },
}))

const mockedAuthorizationApis = oauthAuthorizationApis as jest.Mocked<typeof oauthAuthorizationApis>

describe('OAuth authorization page', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/auth/oauth/authorize?request_id=request-123')
    mockRequestId = 'request-123'
    mockUserState = {
      user: { user_name: 'alice' },
      isLoading: false,
    }
    mockedAuthorizationApis.getRequest.mockResolvedValue({
      request_id: 'request-123',
      client_name: 'External App',
      client_id: 'wgo_client',
      scope: 'userinfo.read',
      redirect_uri: 'https://client.example/callback',
    })
  })

  it('shows the exact identity scope and return URL before consent', async () => {
    render(<Page />)

    expect(await screen.findByText('External App')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('userinfo.read')).toBeInTheDocument()
    expect(screen.getByText('https://client.example/callback')).toBeInTheDocument()
    expect(screen.getByText('auth.oauth_authorize.boundary')).toBeInTheDocument()
    expect(screen.getByTestId('oauth-authorize-approve')).toBeEnabled()
    expect(screen.getByTestId('oauth-authorize-deny')).toBeEnabled()
  })

  it('preserves the authorization request when login is required', async () => {
    mockUserState = { user: null, isLoading: false }

    render(<Page />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        '/login?redirect=%2Fauth%2Foauth%2Fauthorize%3Frequest_id%3Drequest-123'
      )
    })
    expect(sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBe(
      '/auth/oauth/authorize?request_id=request-123'
    )
    expect(mockedAuthorizationApis.getRequest).not.toHaveBeenCalled()
  })

  it('ignores stale request responses after the request ID changes', async () => {
    let resolveFirstRequest!: (value: OAuthAuthorizationRequest) => void
    mockedAuthorizationApis.getRequest
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirstRequest = resolve
          })
      )
      .mockResolvedValueOnce({
        request_id: 'request-456',
        client_name: 'Current App',
        client_id: 'wgo_current',
        scope: 'userinfo.read',
        redirect_uri: 'https://current.example/callback',
      })

    const { rerender } = render(<Page />)
    await waitFor(() => {
      expect(mockedAuthorizationApis.getRequest).toHaveBeenCalledWith('request-123')
    })

    mockRequestId = 'request-456'
    rerender(<Page />)

    expect(await screen.findByText('Current App')).toBeInTheDocument()
    await act(async () => {
      resolveFirstRequest({
        request_id: 'request-123',
        client_name: 'Stale App',
        client_id: 'wgo_stale',
        scope: 'userinfo.read',
        redirect_uri: 'https://stale.example/callback',
      })
    })

    expect(screen.queryByText('Stale App')).not.toBeInTheDocument()
    expect(screen.getByText('Current App')).toBeInTheDocument()
  })
})
