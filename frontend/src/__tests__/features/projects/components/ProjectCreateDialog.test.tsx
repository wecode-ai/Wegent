// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'

import type { DeviceInfo } from '@/apis/devices'
import { ProjectCreateDialog } from '@/features/projects/components/ProjectCreateDialog'

const createProjectMock = jest.fn()
const refreshProjectsMock = jest.fn()
let devicesMock: DeviceInfo[] = []

const baseDevice: DeviceInfo = {
  id: 1,
  device_id: 'device-1',
  name: 'Device 1',
  status: 'online',
  is_default: false,
  device_type: 'local',
  connection_mode: 'websocket',
  slot_used: 0,
  slot_max: 1,
  running_tasks: [],
  executor_version: 'v1.7.11',
  latest_version: 'v1.7.11',
  update_available: false,
  bind_shell: 'claudecode',
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'workspace.deviceVersionUnsupported') {
        return `upgrade required from ${params?.version} to ${params?.requiredVersion}`
      }
      return key
    },
  }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    devices: devicesMock,
  }),
}))

jest.mock('@/features/projects/contexts/projectContext', () => ({
  useProjectContext: () => ({
    createProject: createProjectMock,
    refreshProjects: refreshProjectsMock,
  }),
}))

jest.mock('@/apis/projects', () => ({
  projectApis: {
    createProject: jest.fn(),
    updateProject: jest.fn(),
  },
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode; value: string }) => <div>{children}</div>,
  SelectTrigger: ({
    children,
    ...props
  }: {
    children: React.ReactNode
    'data-testid'?: string
  }) => <button {...props}>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>,
}))

describe('ProjectCreateDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    devicesMock = []
  })

  test('blocks workspace project creation when the selected device version is below v1.7.11', async () => {
    devicesMock = [
      {
        ...baseDevice,
        executor_version: 'v1.7.10',
      },
    ]

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    expect(await screen.findByText('upgrade required from v1.7.10 to v1.7.11')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspaceCreate.submit' })).toBeDisabled()
  })

  test('allows workspace project creation when the selected device version is v1.7.11 or newer', async () => {
    devicesMock = [baseDevice]

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'workspaceCreate.submit' })).not.toBeDisabled()
    })
  })
  test('filters OpenClaw devices from workspace project creation', () => {
    devicesMock = [
      {
        ...baseDevice,
        device_id: 'claudecode-device',
        name: 'ClaudeCode Device',
        bind_shell: 'claudecode',
      },
      {
        ...baseDevice,
        id: 2,
        device_id: 'openclaw-device',
        name: 'OpenClaw Device',
        bind_shell: 'openclaw',
      },
    ]

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    expect(screen.getByText('ClaudeCode Device')).toBeInTheDocument()
    expect(screen.queryByText('OpenClaw Device')).not.toBeInTheDocument()
  })
})
