// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import IMChannelList from '@/features/admin/components/IMChannelList'

const mockToast = jest.fn()
const mockTranslate = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockTranslate,
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
    <select value={value} onChange={event => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    disabled,
    children,
  }: {
    value: string
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <option value="">{placeholder}</option>
  ),
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getIMChannels: jest.fn(),
    getIMChannelStatus: jest.fn(),
    getPublicTeams: jest.fn(),
    getPublicModels: jest.fn(),
    getPublicBots: jest.fn(),
    getUsers: jest.fn(),
    createIMChannel: jest.fn(),
    updateIMChannel: jest.fn(),
    deleteIMChannel: jest.fn(),
    toggleIMChannel: jest.fn(),
    restartIMChannel: jest.fn(),
  },
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('IMChannelList Discord channel config', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockedAdminApis.getIMChannels.mockResolvedValue({ total: 0, items: [] })
    mockedAdminApis.getPublicTeams.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 10,
          name: 'agent',
          namespace: 'default',
          display_name: 'Agent',
          description: null,
          json: { spec: { members: [] } },
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    })
    mockedAdminApis.getPublicModels.mockResolvedValue({ total: 0, items: [] })
    mockedAdminApis.getPublicBots.mockResolvedValue({ total: 0, items: [] })
    mockedAdminApis.getUsers.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 20,
          user_name: 'alice',
          email: 'alice@example.com',
          role: 'user',
          auth_source: 'password',
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ],
    })
  })

  test('shows Discord as a bot-token channel type', async () => {
    render(<IMChannelList />)

    await waitFor(() => {
      expect(mockedAdminApis.getIMChannels).toHaveBeenCalled()
      expect(mockedAdminApis.getPublicTeams).toHaveBeenCalled()
      expect(mockedAdminApis.getPublicModels).toHaveBeenCalled()
      expect(mockedAdminApis.getPublicBots).toHaveBeenCalled()
      expect(mockedAdminApis.getUsers).toHaveBeenCalled()
    })
    await screen.findByText('admin:im_channels.no_channels')
    const createButton = await screen.findByText('admin:im_channels.create_channel')
    fireEvent.click(createButton)

    expect(screen.getByText('admin:im_channels.types.discord')).toBeInTheDocument()

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'discord' },
    })

    expect(screen.getByLabelText('admin:im_channels.form.bot_token *')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('admin:im_channels.form.name *'), {
      target: { value: 'discord-main' },
    })
    fireEvent.change(screen.getByLabelText('admin:im_channels.form.bot_token *'), {
      target: { value: 'discord-token' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: '10' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[4], {
      target: { value: '20' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'admin:common.create' }))

    await waitFor(() => {
      expect(mockedAdminApis.createIMChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'discord-main',
          channel_type: 'discord',
          default_team_id: 10,
          config: expect.objectContaining({
            bot_token: 'discord-token',
            user_mapping_mode: 'select_user',
            user_mapping_config: {
              target_user_id: 20,
            },
          }),
        })
      )
    })
  })
})
