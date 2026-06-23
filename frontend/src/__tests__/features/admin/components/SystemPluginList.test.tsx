// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis, AdminSystemPlugin } from '@/apis/admin'
import SystemPluginList from '@/features/admin/components/SystemPluginList'

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
  AlertDialog: ({
    open,
    children,
  }: {
    open: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (open ? <div>{children}</div> : null),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    [key: string]: unknown
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={event => onCheckedChange?.(event.target.checked)}
      {...props}
    />
  ),
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getSystemPlugins: jest.fn(),
    uploadSystemPlugin: jest.fn(),
    updateSystemPlugin: jest.fn(),
    replaceSystemPluginPackage: jest.fn(),
    deleteSystemPlugin: jest.fn(),
  },
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

function makePlugin(overrides: Partial<AdminSystemPlugin> = {}): AdminSystemPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Plugin',
    metadata: { id: 7, name: 'superpowers', namespace: 'system' },
    spec: {
      source: {
        type: 'upload',
        providerKey: 'claude-code',
        pluginKey: 'superpowers',
        runtime: 'claudecode',
      },
      displayName: 'Superpowers',
      description: 'Shared plugin',
      version: '1.0.0',
      runtime: 'claudecode',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: {},
      components: {
        skills: [{ name: 'plan', description: 'Plan work', path: 'skills/plan/SKILL.md' }],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
        settings: null,
      },
      packageRef: {
        storageKey: 'plugins/superpowers.zip',
        checksum: 'abc',
        sizeBytes: 2048,
      },
      sourcePayload: null,
    },
    status: { state: 'Available' },
    ...overrides,
  }
}

describe('SystemPluginList', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getSystemPlugins.mockResolvedValue({
      total: 1,
      items: [makePlugin()],
    })
    mockedAdminApis.uploadSystemPlugin.mockResolvedValue(makePlugin())
    mockedAdminApis.updateSystemPlugin.mockResolvedValue(makePlugin())
    mockedAdminApis.replaceSystemPluginPackage.mockResolvedValue(makePlugin())
    mockedAdminApis.deleteSystemPlugin.mockResolvedValue(undefined)
  })

  test('shows system plugins and uploads a new plugin package', async () => {
    render(<SystemPluginList />)

    expect(await screen.findByText('Superpowers')).toBeInTheDocument()
    expect(screen.getByText('Shared plugin')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('system-plugin-upload-button'))
    fireEvent.change(screen.getByTestId('system-plugin-runtime-select'), {
      target: { value: 'codex' },
    })
    fireEvent.change(screen.getByTestId('system-plugin-file-input'), {
      target: { files: [new File(['zip'], 'superpowers.zip', { type: 'application/zip' })] },
    })
    fireEvent.click(screen.getByTestId('system-plugin-upload-submit'))

    await waitFor(() => {
      expect(mockedAdminApis.uploadSystemPlugin).toHaveBeenCalledWith(
        expect.any(File),
        true,
        'codex'
      )
    })
  })

  test('updates display metadata and enabled state', async () => {
    render(<SystemPluginList />)

    await screen.findByText('Superpowers')
    fireEvent.click(screen.getByTestId('system-plugin-edit-7'))
    fireEvent.change(screen.getByTestId('system-plugin-display-name-input'), {
      target: { value: 'Updated Superpowers' },
    })
    fireEvent.change(screen.getByTestId('system-plugin-description-input'), {
      target: { value: 'Updated description' },
    })
    fireEvent.click(screen.getByTestId('system-plugin-edit-enabled-switch'))
    fireEvent.click(screen.getByTestId('system-plugin-edit-submit'))

    await waitFor(() => {
      expect(mockedAdminApis.updateSystemPlugin).toHaveBeenCalledWith(7, {
        displayName: 'Updated Superpowers',
        description: 'Updated description',
        enabled: false,
      })
    })
  })
})
