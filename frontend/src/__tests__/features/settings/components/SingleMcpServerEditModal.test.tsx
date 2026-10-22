// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { mcpProviderApis } from '@/apis/mcpProviders'
import SingleMcpServerEditModal from '@/features/settings/components/SingleMcpServerEditModal'
import { normalizeMcpServers, parseMcpConfig } from '@/features/settings/utils/mcpConfig'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/apis/mcpProviders', () => ({
  mcpProviderApis: { testServer: jest.fn() },
}))

jest.mock('@/components/common/CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="MCP JSON"
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  ),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

const serverConfig = {
  type: 'streamable-http',
  url: 'https://example.com/mcp',
  headers: { 'X-Client': 'wegent' },
  timeout: 30,
}

function openEditor() {
  const onSave = jest.fn()
  render(
    <SingleMcpServerEditModal
      open
      onOpenChange={jest.fn()}
      serverName="statusServer"
      serverConfig={serverConfig}
      onSave={onSave}
      onClose={jest.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'common:bot.mcp_json_mode' }))
  return onSave
}

function editJson(config: unknown) {
  fireEvent.change(screen.getByRole('textbox', { name: 'MCP JSON' }), {
    target: { value: JSON.stringify(config) },
  })
}

describe('SingleMcpServerEditModal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(mcpProviderApis.testServer).mockResolvedValue({ success: true, tools: [] })
  })

  it('exports the full hierarchy that the MCP importer accepts', () => {
    const onSave = openEditor()
    const json = (screen.getByRole('textbox', { name: 'MCP JSON' }) as HTMLTextAreaElement).value

    expect(JSON.parse(json)).toEqual({ mcpServers: { statusServer: serverConfig } })
    expect(normalizeMcpServers(parseMcpConfig(json))).toEqual({ statusServer: serverConfig })

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
    expect(onSave).toHaveBeenCalledWith(serverConfig)
  })

  it('unwraps JSON before testing the connection', async () => {
    openEditor()
    const edited = { ...serverConfig, url: 'https://example.com/updated' }
    editJson({ mcpServers: { statusServer: edited } })

    fireEvent.click(screen.getByRole('button', { name: 'common:bot.mcp_test' }))

    await waitFor(() => {
      expect(mcpProviderApis.testServer).toHaveBeenCalledWith({
        server_name: 'statusServer',
        server_config: edited,
      })
      expect(screen.getByText('common:bot.mcp_test_success')).toBeInTheDocument()
    })
  })

  it('preserves JSON edits and extra fields across mode changes', () => {
    const onSave = openEditor()
    const edited = { ...serverConfig, url: 'https://example.com/updated', timeout: 60 }
    editJson({ mcpServers: { statusServer: edited } })

    fireEvent.click(screen.getByRole('button', { name: 'common:bot.mcp_form_mode' }))
    const urlInput = screen.getByDisplayValue(edited.url)
    fireEvent.change(urlInput, { target: { value: 'https://example.com/from-form' } })
    fireEvent.click(screen.getByRole('button', { name: 'common:bot.mcp_json_mode' }))

    const expected = { ...edited, url: 'https://example.com/from-form' }
    const json = (screen.getByRole('textbox', { name: 'MCP JSON' }) as HTMLTextAreaElement).value
    expect(JSON.parse(json)).toEqual({ mcpServers: { statusServer: expected } })
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
    expect(onSave).toHaveBeenCalledWith(expected)
  })

  it.each([
    { mcpServers: { otherServer: serverConfig } },
    { mcpServers: { statusServer: serverConfig, otherServer: serverConfig } },
    { mcpServers: { statusServer: null } },
    {},
    [],
    serverConfig,
  ])('rejects an invalid single-server config: %j', config => {
    const onSave = openEditor()
    editJson(config)

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('common:bot.errors.mcp_config_json')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'common:bot.mcp_form_mode' }))
    expect(screen.getByRole('textbox', { name: 'MCP JSON' })).toHaveValue(JSON.stringify(config))

    fireEvent.click(screen.getByRole('button', { name: 'common:bot.mcp_test' }))
    expect(mcpProviderApis.testServer).not.toHaveBeenCalled()
  })
})
