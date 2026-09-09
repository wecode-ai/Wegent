// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { oauthClientAdminApis, oauthClientApis } from '@/apis/oauthProvider'
import OAuthClientManagement from '@/features/settings/components/OAuthClientManagement'

const mockToast = jest.fn()
const mockTranslate = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

jest.mock('@/apis/oauthProvider', () => ({
  oauthClientApis: {
    getOAuthClients: jest.fn(),
    createOAuthClient: jest.fn(),
    updateOAuthClient: jest.fn(),
    rotateOAuthClientSecret: jest.fn(),
    deleteOAuthClient: jest.fn(),
  },
  oauthClientAdminApis: {
    getOAuthClients: jest.fn(),
    updateOAuthClient: jest.fn(),
    deleteOAuthClient: jest.fn(),
  },
}))

const mockedOAuthClientApis = oauthClientApis as jest.Mocked<typeof oauthClientApis>
const mockedOAuthClientAdminApis = oauthClientAdminApis as jest.Mocked<typeof oauthClientAdminApis>

const client = {
  id: 8,
  owner_user_id: 12,
  owner_user_name: 'developer',
  name: 'External App',
  namespace: 'system',
  client_id: 'wgo_client',
  client_type: 'confidential' as const,
  redirect_uris: ['https://client.example/callback'],
  description: '',
  is_active: true,
  created_at: '2026-08-20T00:00:00Z',
  updated_at: '2026-08-20T00:00:00Z',
  client_secret: null,
}

describe('OAuthClientManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders registered clients and enables creation', async () => {
    mockedOAuthClientApis.getOAuthClients.mockResolvedValue({
      total: 1,
      items: [client],
    })

    render(<OAuthClientManagement />)

    expect(await screen.findByTestId('oauth-client-card-8')).toBeInTheDocument()
    expect(screen.getByText('External App')).toBeInTheDocument()
    expect(screen.getByText('oauth_clients.client_id')).toBeInTheDocument()
    expect(screen.getByTestId('oauth-client-id-8')).toHaveTextContent('wgo_client')
    expect(screen.getByTestId('oauth-client-create-button')).toBeEnabled()
    expect(screen.getByTestId('oauth-client-delete-8')).toHaveAttribute(
      'aria-label',
      'common:actions.delete'
    )
  })

  it('opens client creation without preconfigured signing resources', async () => {
    mockedOAuthClientApis.getOAuthClients.mockResolvedValue({ total: 0, items: [] })

    render(<OAuthClientManagement />)

    expect(await screen.findByText('oauth_clients.empty')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('oauth-client-create-button'))
    expect(screen.getByText('oauth_clients.create_title')).toBeInTheDocument()
    expect(screen.queryByTestId('oauth-client-issuer')).not.toBeInTheDocument()
  })

  it('shows the client ID after creating a public client', async () => {
    mockedOAuthClientApis.getOAuthClients.mockResolvedValue({ total: 0, items: [] })
    mockedOAuthClientApis.createOAuthClient.mockResolvedValue({
      ...client,
      id: 9,
      client_id: 'wgo_public_client',
      client_type: 'public',
      client_secret: null,
    })

    render(<OAuthClientManagement />)

    await screen.findByText('oauth_clients.empty')
    fireEvent.click(screen.getByTestId('oauth-client-create-button'))
    fireEvent.change(screen.getByTestId('oauth-client-name'), {
      target: { value: 'Public App' },
    })
    fireEvent.change(screen.getByTestId('oauth-client-redirect-uris'), {
      target: { value: 'http://127.0.0.1:8765/callback' },
    })
    fireEvent.click(screen.getByTestId('oauth-client-save'))

    await waitFor(() => {
      expect(mockedOAuthClientApis.createOAuthClient).toHaveBeenCalledWith(
        expect.objectContaining({
          client_type: 'public',
        })
      )
    })

    expect(await screen.findByTestId('oauth-client-copy-client-id')).toBeInTheDocument()
    expect(screen.getByTestId('oauth-client-copy-client-id')).toHaveAttribute(
      'aria-label',
      'common:actions.copy'
    )
    expect(screen.getAllByText('wgo_public_client')).toHaveLength(2)
    expect(screen.getByText('oauth_clients.public_credential_note')).toBeInTheDocument()
    expect(screen.queryByTestId('oauth-client-copy-client-secret')).not.toBeInTheDocument()
  })

  it('keeps the admin view limited to governance actions', async () => {
    mockedOAuthClientAdminApis.getOAuthClients.mockResolvedValue({
      total: 1,
      items: [client],
    })

    render(<OAuthClientManagement mode="admin" />)

    expect(await screen.findByTestId('oauth-client-card-8')).toBeInTheDocument()
    expect(screen.getByTestId('oauth-client-owner-8')).toHaveTextContent('developer')
    expect(screen.queryByTestId('oauth-client-create-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('oauth-client-edit-8')).not.toBeInTheDocument()
    expect(screen.queryByTestId('oauth-client-rotate-8')).not.toBeInTheDocument()
    expect(screen.getByTestId('oauth-client-toggle-8')).toBeInTheDocument()
    expect(screen.getByTestId('oauth-client-delete-8')).toBeInTheDocument()
  })
})
