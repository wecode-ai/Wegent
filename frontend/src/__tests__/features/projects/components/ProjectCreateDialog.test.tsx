// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { DeviceInfo } from '@/apis/devices'
import { deviceApis } from '@/apis/devices'
import { projectApis } from '@/apis/projects'
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
      if (key === 'workspace.projectNamePreview') {
        return `project name: ${params?.name}`
      }
      if (key === 'workspace.directoryPicker.selected') {
        return `selected: ${params?.path}`
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

jest.mock('@/apis/devices', () => ({
  deviceApis: {
    executeCommand: jest.fn(),
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

  test('blocks directory selection when the selected device version is exactly 1.0.0', async () => {
    devicesMock = [
      {
        ...baseDevice,
        executor_version: '1.0.0',
      },
    ]

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    expect(await screen.findByText('upgrade required from 1.0.0 to v1.7.11')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-directory-picker-trigger')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'workspaceCreate.submit' })).toBeDisabled()
  })

  test('allows directory selection when the selected device version is v1.7.11 or newer', async () => {
    devicesMock = [
      {
        ...baseDevice,
        executor_version: 'v1.7.11',
      },
    ]

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    await waitFor(() => {
      expect(screen.getByTestId('workspace-directory-picker-trigger')).not.toBeDisabled()
    })
    expect(screen.getByRole('button', { name: 'workspaceCreate.submit' })).toBeDisabled()
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

  test('shows cloud and remote devices in workspace project creation', () => {
    devicesMock = [
      {
        ...baseDevice,
        id: 1,
        device_id: 'cloud-device',
        name: 'Cloud Device',
        device_type: 'cloud',
      },
      {
        ...baseDevice,
        id: 2,
        device_id: 'remote-device',
        name: 'Remote Device',
        device_type: 'remote',
      },
    ]

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    expect(screen.getByText('Cloud Device')).toBeInTheDocument()
    expect(screen.getByText('Remote Device')).toBeInTheDocument()
  })

  test('creates workspace project from selected device directory', async () => {
    devicesMock = [
      {
        ...baseDevice,
        executor_version: 'v1.7.11',
      },
    ]
    ;(deviceApis.executeCommand as jest.Mock).mockImplementation((_deviceId, request) => {
      if (request.command_key === 'pwd') {
        return Promise.resolve({
          success: true,
          exit_code: 0,
          stdout: '/Users/dev\n',
          stderr: '',
          duration: 0.01,
        })
      }

      return Promise.resolve({
        success: true,
        exit_code: 0,
        stdout: ['repo', 'tmp'],
        stderr: '',
        duration: 0.01,
      })
    })
    ;(projectApis.createProject as jest.Mock).mockResolvedValue({ id: 10 })

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    const pickerTrigger = await screen.findByTestId('workspace-directory-picker-trigger')
    await waitFor(() => expect(pickerTrigger).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'workspaceCreate.submit' })).toBeDisabled()

    fireEvent.click(pickerTrigger)
    const repoRow = await screen.findByText('repo')
    fireEvent.click(repoRow)
    fireEvent.click(screen.getByTestId('workspace-directory-confirm-button'))

    expect(await screen.findByText('project name: repo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'workspaceCreate.submit' }))

    await waitFor(() => {
      expect(projectApis.createProject).toHaveBeenCalledWith({
        name: 'repo',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-1',
          },
          workspace: {
            source: 'local_path',
            localPath: '/Users/dev/repo',
          },
        },
      })
    })
  })

  test('creates cloud workspace project from selected device directory', async () => {
    devicesMock = [
      {
        ...baseDevice,
        device_id: 'cloud-device',
        name: 'Cloud Device',
        device_type: 'cloud',
        executor_version: 'v1.7.11',
      },
    ]
    ;(deviceApis.executeCommand as jest.Mock).mockResolvedValue({
      success: true,
      exit_code: 0,
      stdout: ['repo', 'tmp'],
      stderr: '',
      duration: 0.01,
    })
    ;(projectApis.createProject as jest.Mock).mockResolvedValue({ id: 11 })

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    const pickerTrigger = await screen.findByTestId('workspace-directory-picker-trigger')
    await waitFor(() => expect(pickerTrigger).not.toBeDisabled())
    fireEvent.click(pickerTrigger)

    await waitFor(() => {
      expect(deviceApis.executeCommand).toHaveBeenCalledWith(
        'cloud-device',
        expect.objectContaining({
          command_key: 'ls_dirs',
          path: '/',
        })
      )
    })

    fireEvent.click(await screen.findByText('repo'))
    fireEvent.click(screen.getByTestId('workspace-directory-confirm-button'))
    expect(await screen.findByText('project name: repo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'workspaceCreate.submit' }))

    await waitFor(() => {
      expect(projectApis.createProject).toHaveBeenCalledWith({
        name: 'repo',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'cloud',
            deviceId: 'cloud-device',
          },
          workspace: {
            source: 'device_path',
            devicePath: '/repo',
          },
        },
      })
    })
  })

  test('creates remote workspace project from selected device directory', async () => {
    devicesMock = [
      {
        ...baseDevice,
        device_id: 'remote-device',
        name: 'Remote Device',
        device_type: 'remote',
        executor_version: 'v1.7.11',
      },
    ]
    ;(deviceApis.executeCommand as jest.Mock).mockImplementation((_deviceId, request) => {
      return Promise.resolve({
        success: true,
        exit_code: 0,
        stdout: request.path === '/srv' ? ['repo'] : ['srv'],
        stderr: '',
        duration: 0.01,
      })
    })
    ;(projectApis.createProject as jest.Mock).mockResolvedValue({ id: 12 })

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    const pickerTrigger = await screen.findByTestId('workspace-directory-picker-trigger')
    await waitFor(() => expect(pickerTrigger).not.toBeDisabled())
    fireEvent.click(pickerTrigger)

    await waitFor(() => {
      expect(deviceApis.executeCommand).toHaveBeenCalledWith(
        'remote-device',
        expect.objectContaining({
          command_key: 'ls_dirs',
          path: '/',
        })
      )
    })

    fireEvent.doubleClick(await screen.findByText('srv'))
    fireEvent.click(await screen.findByText('repo'))
    fireEvent.click(screen.getByTestId('workspace-directory-confirm-button'))
    expect(await screen.findByText('project name: repo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'workspaceCreate.submit' }))

    await waitFor(() => {
      expect(projectApis.createProject).toHaveBeenCalledWith({
        name: 'repo',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'remote',
            deviceId: 'remote-device',
          },
          workspace: {
            source: 'device_path',
            devicePath: '/srv/repo',
          },
        },
      })
    })
  })

  test('double-click selects and opens a subdirectory in the directory picker', async () => {
    devicesMock = [
      {
        ...baseDevice,
        executor_version: 'v1.7.11',
      },
    ]
    ;(deviceApis.executeCommand as jest.Mock).mockImplementation((_deviceId, request) => {
      if (request.command_key === 'pwd') {
        return Promise.resolve({
          success: true,
          exit_code: 0,
          stdout: '/Users/dev\n',
          stderr: '',
          duration: 0.01,
        })
      }

      return Promise.resolve({
        success: true,
        exit_code: 0,
        stdout: request.path === '/Users/dev/repo' ? ['src'] : ['repo'],
        stderr: '',
        duration: 0.01,
      })
    })

    render(<ProjectCreateDialog open={true} onOpenChange={jest.fn()} mode="workspace" />)

    const pickerTrigger = await screen.findByTestId('workspace-directory-picker-trigger')
    await waitFor(() => expect(pickerTrigger).not.toBeDisabled())
    fireEvent.click(pickerTrigger)

    const repoRow = await screen.findByText('repo')
    fireEvent.doubleClick(repoRow)

    await waitFor(() => {
      expect(deviceApis.executeCommand).toHaveBeenCalledWith(
        'device-1',
        expect.objectContaining({
          command_key: 'ls_dirs',
          path: '/Users/dev/repo',
        })
      )
    })
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-directory-selected-path')).toHaveTextContent(
      'selected: /Users/dev/repo'
    )
  })
})
