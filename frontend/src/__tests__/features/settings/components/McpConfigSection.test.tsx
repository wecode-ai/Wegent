// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'

import McpConfigSection from '@/features/settings/components/McpConfigSection'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:bot.mcp_config': 'MCP Config',
        'common:bot.edit_mcp_json': 'Edit',
        'common:bot.add_mcp_json': 'Add',
        'bot.add_mcp_json': 'Add',
        'bot.import_mcp_desc': 'Import MCP config',
        'bot.mcp_add_dialog_title': 'Add MCP server',
        'bot.mcp_add_manual_tab': 'Manual',
        'bot.mcp_add_provider_tab': 'Providers',
        'common:bot.mcp_add_dialog_title': 'Add MCP server',
        'common:bot.mcp_add_manual_tab': 'Manual',
        'common:bot.mcp_add_provider_tab': 'Providers',
        'common:bot.no_mcp_servers': 'No MCP servers configured',
        'actions.cancel': 'Cancel',
        'common:mcpProviders.provider_button': 'Providers',
      })[key] || key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/features/settings/components/McpConfigEditModal', () => () => null)
jest.mock('@/features/settings/components/McpConfigImportModal', () => () => null)
jest.mock('@/features/settings/components/McpProviderModal', () => ({
  __esModule: true,
  default: () => null,
  McpProviderBrowser: () => <div data-testid="mcp-provider-browser" />,
}))
jest.mock('@/features/settings/components/SingleMcpServerEditModal', () => () => null)

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

describe('McpConfigSection', () => {
  it('keeps the full MCP configuration layout unchanged outside compact mode', () => {
    render(<McpConfigSection mcpConfig="{}" onMcpConfigChange={jest.fn()} toast={jest.fn()} />)

    expect(screen.getByText('MCP Config')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Providers' })).toBeInTheDocument()
    expect(screen.queryByTestId('mcp-config-actions')).not.toBeInTheDocument()
  })

  it('uses a single plus entry for manual and provider additions', () => {
    render(
      <McpConfigSection
        mcpConfig="{}"
        onMcpConfigChange={jest.fn()}
        toast={jest.fn()}
        hideHeaderLabel
        compact
      />
    )

    const actionGroup = screen.getByTestId('mcp-config-actions')

    expect(actionGroup).toHaveClass('h-9')
    expect(actionGroup).toHaveClass('border-border/50')
    expect(within(actionGroup).queryByTestId('edit-mcp-config-button')).not.toBeInTheDocument()
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
    expect(screen.queryByText('Add')).not.toBeInTheDocument()
    expect(screen.queryByText('Providers')).not.toBeInTheDocument()

    fireEvent.click(actionGroup)

    expect(screen.getByText('Add MCP server')).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Providers', 'Manual'])
    expect(screen.getByRole('tab', { name: 'Manual' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('mcp-provider-browser')).toBeInTheDocument()
  })
})
