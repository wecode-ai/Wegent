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

describe('IMChannelList channel config', () => {
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

  test('creates a Weibo channel with Open IM credentials', async () => {
    render(<IMChannelList />)

    await waitFor(() => {
      expect(mockedAdminApis.getIMChannels).toHaveBeenCalled()
      expect(mockedAdminApis.getPublicTeams).toHaveBeenCalled()
      expect(mockedAdminApis.getUsers).toHaveBeenCalled()
    })
    const createButton = await screen.findByText('admin:im_channels.create_channel')
    fireEvent.click(createButton)

    expect(screen.getByText('admin:im_channels.types.weibo')).toBeInTheDocument()

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'weibo' },
    })

    expect(screen.getByLabelText('admin:im_channels.form.weibo_app_id *')).toBeInTheDocument()
    expect(screen.getByLabelText('admin:im_channels.form.weibo_app_secret *')).toBeInTheDocument()
    expect(screen.getByLabelText('admin:im_channels.form.weibo_ws_endpoint')).toBeInTheDocument()
    expect(screen.getByLabelText('admin:im_channels.form.weibo_token_endpoint')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('admin:im_channels.form.name *'), {
      target: { value: 'weibo-main' },
    })
    fireEvent.change(screen.getByLabelText('admin:im_channels.form.weibo_app_id *'), {
      target: { value: 'weibo-app' },
    })
    fireEvent.change(screen.getByLabelText('admin:im_channels.form.weibo_app_secret *'), {
      target: { value: 'weibo-secret' },
    })
    fireEvent.change(screen.getByLabelText('admin:im_channels.form.weibo_ws_endpoint'), {
      target: { value: 'wss://example.com/ws' },
    })
    fireEvent.change(screen.getByLabelText('admin:im_channels.form.weibo_token_endpoint'), {
      target: { value: 'https://example.com/token' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: '10' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[4], {
      target: { value: '20' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'admin:common.create' }))

    await waitFor(() => {
      expect(mockedAdminApis.createIMChannel).toHaveBeenCalled()
    })

    const payload = mockedAdminApis.createIMChannel.mock.calls[0][0]
    expect(payload).toEqual(
      expect.objectContaining({
        name: 'weibo-main',
        channel_type: 'weibo',
        default_team_id: 10,
      })
    )
    expect(payload.config).toEqual(
      expect.objectContaining({
        app_id: 'weibo-app',
        app_secret: 'weibo-secret',
        ws_endpoint: 'wss://example.com/ws',
        token_endpoint: 'https://example.com/token',
        user_mapping_mode: 'select_user',
        user_mapping_config: {
          target_user_id: 20,
        },
      })
    )
    expect(payload.config).not.toHaveProperty('client_id')
    expect(payload.config).not.toHaveProperty('client_secret')
  })

  test('edits a Weibo channel without exposing the existing app secret', async () => {
    mockedAdminApis.getIMChannels.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 7,
          name: 'weibo-main',
          channel_type: 'weibo',
          is_enabled: false,
          config: {
            app_id: 'weibo-app',
            app_secret: '***',
            ws_endpoint: 'wss://old.example.com/ws',
            token_endpoint: 'https://old.example.com/token',
            user_mapping_mode: 'select_user',
            user_mapping_config: {
              target_user_id: 20,
            },
          },
          default_team_id: 10,
          default_model_name: '',
          created_at: '',
          updated_at: '',
          created_by: 0,
        },
      ],
    })

    render(<IMChannelList />)

    await screen.findByText('weibo-main')
    fireEvent.click(screen.getByTitle('admin:im_channels.edit_channel'))

    expect(screen.getByLabelText('admin:im_channels.form.weibo_app_id')).toHaveValue('weibo-app')
    expect(screen.getByLabelText('admin:im_channels.form.weibo_app_secret')).toHaveValue('')
    expect(screen.getByLabelText('admin:im_channels.form.weibo_ws_endpoint')).toHaveValue(
      'wss://old.example.com/ws'
    )
    expect(screen.getByLabelText('admin:im_channels.form.weibo_token_endpoint')).toHaveValue(
      'https://old.example.com/token'
    )

    fireEvent.change(screen.getByLabelText('admin:im_channels.form.weibo_app_id'), {
      target: { value: 'weibo-app-2' },
    })
    fireEvent.change(screen.getByLabelText('admin:im_channels.form.weibo_app_secret'), {
      target: { value: 'new-secret' },
    })
    fireEvent.change(screen.getByLabelText('admin:im_channels.form.weibo_ws_endpoint'), {
      target: { value: 'wss://new.example.com/ws' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'admin:common.save' }))

    await waitFor(() => {
      expect(mockedAdminApis.updateIMChannel).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          config: expect.objectContaining({
            app_id: 'weibo-app-2',
            app_secret: 'new-secret',
            ws_endpoint: 'wss://new.example.com/ws',
            token_endpoint: 'https://old.example.com/token',
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
