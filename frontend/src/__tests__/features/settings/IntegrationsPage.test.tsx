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

jest.mock('@/features/settings/components/McpProviderIntegrations', () => ({
  __esModule: true,
  default: ({ providerId }: { providerId: string }) => <div>MCP Provider: {providerId}</div>,
}))

jest.mock('@wecode/components/settings/EmailTokenSection', () => ({
  __esModule: true,
  EmailTokenSection: () => <div>Company Email Section</div>,
}))

describe('IntegrationsPage', () => {
  it('keeps other integrations visible while hiding the company email section', () => {
    render(<IntegrationsPage />)

    expect(screen.getByText('Integrations')).toBeInTheDocument()
    expect(screen.getByText('GitHub Integration Section')).toBeInTheDocument()
    expect(screen.getByText('MCP Provider: dingtalk')).toBeInTheDocument()
    expect(screen.queryByText('Company Email Section')).not.toBeInTheDocument()
  })
})
