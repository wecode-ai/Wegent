// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import ConnectorAppList from '@/features/admin/components/ConnectorAppList'

const mockToast = jest.fn()

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={event => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={event => onCheckedChange(event.currentTarget.checked)}
    />
  ),
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getConnectorApps: jest.fn(),
    createConnectorApp: jest.fn(),
    updateConnectorApp: jest.fn(),
    disableConnectorApp: jest.fn(),
  },
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('ConnectorAppList', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getConnectorApps.mockResolvedValue([])
    mockedAdminApis.createConnectorApp.mockResolvedValue({} as never)
  })

  test('creates a public OAuth connector with policy fields', async () => {
    render(<ConnectorAppList />)

    await screen.findByText('connector_apps.empty')
    fireEvent.click(screen.getByTestId('create-connector-app-button'))
    fireEvent.change(screen.getByTestId('connector-app-name'), {
      target: { value: 'Internal Docs' },
    })
    fireEvent.change(screen.getByTestId('connector-app-slug'), {
      target: { value: 'internal-docs' },
    })
    fireEvent.change(screen.getByTestId('connector-app-mcp-url'), {
      target: { value: 'https://mcp.example.test/docs' },
    })

    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[1], { target: { value: 'oauth2' } })
    fireEvent.change(screen.getByTestId('connector-app-oauth-authorization-url'), {
      target: { value: 'https://identity.example.test/authorize' },
    })
    fireEvent.change(screen.getByTestId('connector-app-oauth-token-url'), {
      target: { value: 'https://identity.example.test/token' },
    })
    fireEvent.change(screen.getByTestId('connector-app-oauth-client-id'), {
      target: { value: 'wegent-desktop' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[3], {
      target: { value: 'none' },
    })
    fireEvent.change(screen.getByTestId('connector-app-oauth-scopes'), {
      target: { value: 'docs.read\ndocs.search' },
    })
    fireEvent.change(screen.getByTestId('connector-app-provider-headers'), {
      target: { value: '{"X-Tenant":"internal"}' },
    })
    fireEvent.change(screen.getByTestId('connector-app-tool-allowlist'), {
      target: { value: 'search\nread' },
    })
    fireEvent.click(screen.getByTestId('save-connector-app-button'))

    await waitFor(() => {
      expect(mockedAdminApis.createConnectorApp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'internal-docs',
          auth_type: 'oauth2',
          oauth_client_auth_method: 'none',
          oauth_scopes: ['docs.read', 'docs.search'],
          provider_headers: { 'X-Tenant': 'internal' },
          tool_allowlist: ['search', 'read'],
        })
      )
    })
  })
})
