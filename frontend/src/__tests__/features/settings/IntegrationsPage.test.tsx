// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import IntegrationsPage from '@/features/settings/components/IntegrationsPage'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'common:integrations.title': 'Integrations',
        'common:integrations.description': 'Manage external integrations',
      }
      return translations[key] || key
    },
  }),
}))

jest.mock('@/features/settings/components/GitHubIntegration', () => ({
  __esModule: true,
  default: () => <div>GitHub Integration Section</div>,
}))

jest.mock('@/features/settings/components/ConnectorAppConnections', () => ({
  __esModule: true,
  default: () => <div>Connector App Connections Section</div>,
}))

describe('IntegrationsPage', () => {
  it('shows connector app connections without the legacy provider card', () => {
    render(<IntegrationsPage />)

    expect(screen.getByText('Integrations')).toBeInTheDocument()
    expect(screen.getByText('GitHub Integration Section')).toBeInTheDocument()
    expect(screen.getByText('Connector App Connections Section')).toBeInTheDocument()
    expect(screen.queryByText(/MCP Provider:/)).not.toBeInTheDocument()
  })
})
