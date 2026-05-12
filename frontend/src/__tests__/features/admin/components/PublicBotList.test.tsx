// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import PublicBotList from '@/features/admin/components/PublicBotList'
import { adminApis } from '@/apis/admin'

const mockToast = jest.fn()

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/components/common/UnifiedAddButton', () => {
  function MockUnifiedAddButton({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) {
    return <button onClick={onClick}>{children}</button>
  }

  return MockUnifiedAddButton
})

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      data-testid="mock-select"
      value={value}
      onChange={event => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <option value="">{placeholder}</option>
  ),
}))

jest.mock('@/features/settings/components/knowledge/KnowledgeBaseMultiSelector', () => ({
  KnowledgeBaseMultiSelector: ({
    value,
    onChange,
    allowedSources,
  }: {
    value: Array<{ id: number; name: string }>
    onChange: (value: Array<{ id: number; name: string }>) => void
    allowedSources?: string[]
  }) => (
    <div data-testid="knowledge-base-selector" data-allowed-sources={allowedSources?.join(',')}>
      <div data-testid="knowledge-base-count">{value.length}</div>
      <button
        type="button"
        data-testid="knowledge-base-add"
        onClick={() => onChange([...value, { id: 303, name: 'Security Policies' }])}
      >
        add kb
      </button>
    </div>
  ),
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getPublicBots: jest.fn(),
    createPublicBot: jest.fn(),
    updatePublicBot: jest.fn(),
    deletePublicBot: jest.fn(),
    getPublicGhosts: jest.fn(),
    getPublicShells: jest.fn(),
    getPublicModels: jest.fn(),
  },
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('PublicBotList knowledge base binding', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockedAdminApis.getPublicBots.mockResolvedValue({
      total: 0,
      items: [],
    })
    mockedAdminApis.getPublicGhosts.mockResolvedValue({
      total: 0,
      items: [],
    })
    mockedAdminApis.getPublicShells.mockResolvedValue({
      total: 2,
      items: [
        {
          id: 1,
          name: 'claude-shell',
          namespace: 'default',
          display_name: 'Claude Shell',
          shell_type: 'ClaudeCode',
          json: {},
          is_active: true,
          created_at: '',
          updated_at: '',
        },
        {
          id: 2,
          name: 'dify-shell',
          namespace: 'default',
          display_name: 'Dify Shell',
          shell_type: 'Dify',
          json: {},
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    })
    mockedAdminApis.getPublicModels.mockResolvedValue({
      total: 0,
      items: [],
    })
    mockedAdminApis.createPublicBot.mockResolvedValue({
      id: 10,
      name: 'bot-a',
      namespace: 'default',
      display_name: null,
      json: {},
      is_active: true,
      created_at: '',
      updated_at: '',
      ghost_name: null,
      shell_name: 'claude-shell',
      model_name: null,
      system_prompt: null,
      mcp_servers: null,
      skills: null,
      agent_config: null,
      default_knowledge_base_refs: [{ id: 303, name: 'Security Policies' }],
    })
    mockedAdminApis.updatePublicBot.mockResolvedValue({
      id: 11,
      name: 'legacy-dify-bot',
      namespace: 'default',
      display_name: null,
      json: {},
      is_active: true,
      created_at: '',
      updated_at: '',
      ghost_name: null,
      shell_name: 'dify-shell',
      model_name: null,
      system_prompt: null,
      mcp_servers: null,
      skills: null,
      agent_config: null,
      default_knowledge_base_refs: [],
    })
  })

  test('hides selector for Dify shell and shows org-only selector for non-Dify', async () => {
    render(<PublicBotList />)

    fireEvent.click(await screen.findByText('public_bots.create_bot'))

    expect(await screen.findByTestId('knowledge-base-selector')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-base-selector')).toHaveAttribute(
      'data-allowed-sources',
      'organization'
    )

    const selects = await screen.findAllByTestId('mock-select')
    fireEvent.change(selects[1], { target: { value: 'dify-shell' } })

    await waitFor(() => {
      expect(screen.queryByTestId('knowledge-base-selector')).not.toBeInTheDocument()
    })
  })

  test('includes default knowledge base refs when creating non-Dify public bots', async () => {
    render(<PublicBotList />)

    fireEvent.click(await screen.findByText('public_bots.create_bot'))

    const selects = await screen.findAllByTestId('mock-select')
    fireEvent.change(selects[1], { target: { value: 'claude-shell' } })

    fireEvent.change(screen.getByLabelText('public_bots.form.name *'), {
      target: { value: 'Knowledge Bot' },
    })
    fireEvent.click(screen.getByTestId('knowledge-base-add'))
    fireEvent.click(screen.getByText('common.create'))

    await waitFor(() => {
      expect(mockedAdminApis.createPublicBot).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Knowledge Bot',
          default_knowledge_base_refs: [{ id: 303, name: 'Security Policies' }],
        })
      )
    })
  })

  test('hides selector for legacy Dify bots without shellRef in config', async () => {
    mockedAdminApis.getPublicBots.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 11,
          name: 'legacy-dify-bot',
          namespace: 'default',
          display_name: null,
          json: { spec: {} },
          is_active: true,
          created_at: '',
          updated_at: '',
          ghost_name: null,
          shell_name: 'dify-shell',
          model_name: null,
          system_prompt: null,
          mcp_servers: null,
          skills: null,
          agent_config: null,
          default_knowledge_base_refs: [{ id: 303, name: 'Security Policies' }],
        },
      ],
    })

    render(<PublicBotList />)

    fireEvent.click(await screen.findByTitle('public_bots.edit_bot'))

    await waitFor(() => {
      expect(screen.queryByTestId('knowledge-base-selector')).not.toBeInTheDocument()
    })
  })
})
