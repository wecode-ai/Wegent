// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import { botApis } from '@/apis/bots'
import { teamApis } from '@/apis/team'
import { McpTargetSelectorDialog } from '@/features/resource-library/components/McpTargetSelectorDialog'

const mockToast = jest.fn()
const mockOpenChange = jest.fn()
const mockT = (key: string) => key

jest.mock('@/apis/bots', () => ({
  botApis: {
    getBots: jest.fn(),
    updateBot: jest.fn(),
  },
}))

jest.mock('@/apis/team', () => ({
  teamApis: {
    getTeams: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: ReactNode
  }) =>
    open ? (
      <div>
        <button type="button" data-testid="dialog-outside" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const mockedBotApis = botApis as jest.Mocked<typeof botApis>
const mockedTeamApis = teamApis as jest.Mocked<typeof teamApis>

describe('McpTargetSelectorDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedTeamApis.getTeams.mockResolvedValue({
      total: 2,
      items: [
        {
          id: 10,
          name: 'research-agent',
          displayName: '研究智能体',
          description: '',
          bots: [{ bot_id: 20, bot_prompt: '' }],
          workflow: {},
          is_active: true,
          user_id: 1,
          created_at: '',
          updated_at: '',
        },
        {
          id: 11,
          name: 'image-agent',
          displayName: '图片智能体',
          description: '生成图片',
          bots: [{ bot_id: 21, bot_prompt: '' }],
          workflow: {},
          is_active: true,
          user_id: 1,
          created_at: '',
          updated_at: '',
        },
      ],
    })
    mockedBotApis.getBots.mockResolvedValue({
      total: 2,
      items: [
        {
          id: 20,
          name: '搜索机器人',
          shell_name: 'ClaudeCode',
          shell_type: 'ClaudeCode',
          agent_config: {},
          system_prompt: '',
          mcp_servers: {
            existing: { type: 'stdio', command: 'existing' },
          },
          is_active: true,
          created_at: '',
          updated_at: '',
        },
        {
          id: 21,
          name: '图片机器人',
          shell_name: 'Chat',
          shell_type: 'Chat',
          agent_config: {},
          system_prompt: '',
          mcp_servers: {},
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    })
    mockedBotApis.updateBot.mockResolvedValue({
      id: 20,
      name: '搜索机器人',
      shell_name: 'ClaudeCode',
      shell_type: 'ClaudeCode',
      agent_config: {},
      system_prompt: '',
      mcp_servers: {},
      is_active: true,
      created_at: '',
      updated_at: '',
    })
  })

  it('selects multiple Bots and adds the MCP in one submission', async () => {
    const user = userEvent.setup()
    render(
      <McpTargetSelectorDialog
        open
        onOpenChange={mockOpenChange}
        server={{
          id: '@community/search',
          name: 'Content Search',
          description: 'Search community content',
          type: 'streamable-http',
          base_url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer token' },
          is_active: true,
          provider: 'Community MCP',
        }}
      />
    )

    expect(await screen.findByText('研究智能体')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-target-agent-card-10')).toHaveClass(
      'rounded-xl',
      'shadow-sm',
      'hover:shadow-md'
    )

    await user.type(screen.getByTestId('mcp-target-search-input'), '图片')
    expect(screen.queryByTestId('mcp-target-agent-card-10')).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-target-agent-card-11')).toBeInTheDocument()
    await user.click(screen.getByTestId('mcp-target-search-clear'))

    await user.click(screen.getByTestId('mcp-target-team-10-bot-20'))
    await user.click(screen.getByTestId('mcp-target-team-11-bot-21'))

    expect(screen.getByTestId('mcp-target-team-10-bot-20')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('mcp-target-team-11-bot-21')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('mcp-target-checkbox-20')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('mcp-target-checkbox-21')).toHaveAttribute('data-state', 'checked')
    expect(mockedBotApis.updateBot).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('mcp-target-submit'))

    await waitFor(() =>
      expect(mockedBotApis.updateBot).toHaveBeenCalledWith(20, {
        mcp_servers: {
          existing: { type: 'stdio', command: 'existing' },
          '%40community%2Fsearch': {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer token' },
          },
        },
      })
    )
    expect(mockedBotApis.updateBot).toHaveBeenCalledWith(21, {
      mcp_servers: {
        '%40community%2Fsearch': {
          type: 'streamable-http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      },
    })
    expect(mockedBotApis.updateBot).toHaveBeenCalledTimes(2)
    expect(mockOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes without saving when the user clicks outside', async () => {
    const user = userEvent.setup()
    render(
      <McpTargetSelectorDialog
        open
        onOpenChange={mockOpenChange}
        server={{
          id: '@community/search',
          name: 'Content Search',
          description: 'Search community content',
          type: 'streamable-http',
          base_url: 'https://example.test/mcp',
          is_active: true,
          provider: 'Community MCP',
        }}
      />
    )

    await user.click(await screen.findByTestId('mcp-target-team-10-bot-20'))
    await user.click(screen.getByTestId('dialog-outside'))

    expect(mockedBotApis.updateBot).not.toHaveBeenCalled()
    expect(mockOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps only failed Bots selected for retry', async () => {
    mockedBotApis.updateBot
      .mockResolvedValueOnce({
        id: 20,
        name: '搜索机器人',
        shell_name: 'ClaudeCode',
        shell_type: 'ClaudeCode',
        agent_config: {},
        system_prompt: '',
        mcp_servers: {},
        is_active: true,
        created_at: '',
        updated_at: '',
      })
      .mockRejectedValueOnce(new Error('failed'))

    const user = userEvent.setup()
    render(
      <McpTargetSelectorDialog
        open
        onOpenChange={mockOpenChange}
        server={{
          id: '@community/search',
          name: 'Content Search',
          description: 'Search community content',
          type: 'streamable-http',
          base_url: 'https://example.test/mcp',
          is_active: true,
          provider: 'Community MCP',
        }}
      />
    )

    await user.click(await screen.findByTestId('mcp-target-team-10-bot-20'))
    await user.click(screen.getByTestId('mcp-target-team-11-bot-21'))
    await user.click(screen.getByTestId('mcp-target-submit'))

    await waitFor(() =>
      expect(screen.getByTestId('mcp-target-team-10-bot-20')).toHaveAttribute(
        'aria-checked',
        'false'
      )
    )
    expect(screen.getByTestId('mcp-target-team-11-bot-21')).toHaveAttribute('aria-checked', 'true')
    expect(mockOpenChange).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        title: 'mcp_market.bind_partial_failed',
      })
    )
  })

  it('does not offer Bots whose executor does not support MCP', async () => {
    mockedTeamApis.getTeams.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 12,
          name: 'dify-agent',
          displayName: 'Dify 智能体',
          description: '',
          bots: [{ bot_id: 22, bot_prompt: '' }],
          workflow: {},
          is_active: true,
          user_id: 1,
          created_at: '',
          updated_at: '',
        },
      ],
    })
    mockedBotApis.getBots.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 22,
          name: 'Dify 机器人',
          shell_name: 'Dify',
          shell_type: 'Dify',
          agent_config: {},
          system_prompt: '',
          mcp_servers: {},
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    })

    render(
      <McpTargetSelectorDialog
        open
        onOpenChange={mockOpenChange}
        server={{
          id: '@community/search',
          name: 'Content Search',
          description: 'Search community content',
          type: 'streamable-http',
          base_url: 'https://example.test/mcp',
          is_active: true,
          provider: 'Community MCP',
        }}
      />
    )

    expect(await screen.findByText('mcp_market.no_targets')).toBeInTheDocument()
    expect(screen.queryByText('Dify 智能体')).not.toBeInTheDocument()
  })
})
