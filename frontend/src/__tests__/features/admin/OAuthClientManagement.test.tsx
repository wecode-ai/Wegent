// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import OAuthClientManagement from '@/features/admin/components/OAuthClientManagement'

const mockToast = jest.fn()
const mockTranslate = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getOAuthClients: jest.fn(),
    getTokenIssuers: jest.fn(),
    createOAuthClient: jest.fn(),
    updateOAuthClient: jest.fn(),
    rotateOAuthClientSecret: jest.fn(),
    deleteOAuthClient: jest.fn(),
  },
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('OAuthClientManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getTokenIssuers.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 3,
          name: 'userinfo-issuer',
          namespace: 'system',
          issuer: 'wegent-oauth',
          audience: 'wegent-userinfo',
          default_ttl_seconds: 600,
          max_ttl_seconds: 3600,
          description: '',
          signing_key_id: 2,
          signing_key_name: 'oauth-key',
          signing_key_kid: 'kid-1',
          public_key_pem: 'public-key',
          is_active: true,
          created_at: '2026-08-20T00:00:00Z',
          updated_at: '2026-08-20T00:00:00Z',
        },
      ],
    })
  })

  it('renders registered clients and enables creation with an eligible issuer', async () => {
    mockedAdminApis.getOAuthClients.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 8,
          name: 'External App',
          namespace: 'system',
          client_id: 'wgo_client',
          client_type: 'confidential',
          redirect_uris: ['https://client.example/callback'],
          token_issuer_id: 3,
          token_issuer_name: 'userinfo-issuer',
          access_ttl_seconds: 600,
          refresh_ttl_seconds: 2592000,
          description: '',
          is_active: true,
          created_at: '2026-08-20T00:00:00Z',
          updated_at: '2026-08-20T00:00:00Z',
          client_secret: null,
        },
      ],
    })

    render(<OAuthClientManagement />)

    expect(await screen.findByTestId('oauth-client-card-8')).toBeInTheDocument()
    expect(screen.getByText('External App')).toBeInTheDocument()
    expect(screen.getByTestId('oauth-client-create-button')).toBeEnabled()
    expect(screen.queryByText('oauth_clients.no_issuer')).not.toBeInTheDocument()
  })

  it('blocks client creation when no userinfo issuer is available', async () => {
    mockedAdminApis.getOAuthClients.mockResolvedValue({ total: 0, items: [] })
    mockedAdminApis.getTokenIssuers.mockResolvedValue({ total: 0, items: [] })

    render(<OAuthClientManagement />)

    expect(await screen.findByText('oauth_clients.no_issuer')).toBeInTheDocument()
    expect(screen.getByTestId('oauth-client-create-button')).toBeDisabled()
  })
})
