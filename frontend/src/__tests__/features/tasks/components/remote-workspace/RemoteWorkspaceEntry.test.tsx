// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import { remoteWorkspaceApis } from '@/apis/remoteWorkspace'
import { RemoteWorkspaceEntry } from '@/features/tasks/components/remote-workspace/RemoteWorkspaceEntry'

jest.mock('@/apis/remoteWorkspace', () => ({
  remoteWorkspaceApis: {
    getStatus: jest.fn(),
    getTree: jest.fn(),
  },
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: jest.fn(() => false),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'remote_workspace.button': 'Remote Workspace',
        'remote_workspace.unavailable': 'Remote session unavailable',
        'remote_workspace.reason_loading': 'Checking remote workspace status...',
        'remote_workspace.reason_status_check_failed': 'Failed to check remote workspace status',
        'remote_workspace.reason_not_connected': 'Remote session is not connected yet',
        'remote_workspace.reason_sandbox_not_running': 'Remote sandbox is not running',
        'remote_workspace.reason_booting': 'Remote workspace is booting',
        'remote_workspace.reason_warming': 'Remote workspace is warming up',
        'remote_workspace.reason_starting': 'Remote workspace is starting',
        'remote_workspace.status.has_files': 'Files',
        'tasks:remote_workspace.button': 'Remote Workspace',
        'tasks:remote_workspace.unavailable': 'Remote session unavailable',
      }
      return translations[key] || key
    },
  }),
}))

describe('RemoteWorkspaceEntry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(remoteWorkspaceApis.getTree as jest.Mock).mockResolvedValue({
      path: '/workspace',
      entries: [],
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('shows disabled button when connected but unavailable', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: false,
      root_path: '/workspace',
      reason: 'sandbox_not_running',
    })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledWith(1)
    })

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Remote Workspace' })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', 'Remote sandbox is not running')
    })
  })

  test('shows disabled button when forceDisabled is true', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" forceDisabled={true} />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledWith(1)
    })

    const button = screen.getByRole('button', { name: 'Remote Workspace' })
    expect(button).toBeDisabled()
  })

  test('uses compact header button size classes', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledWith(1)
    })

    const button = screen.getByRole('button', { name: 'Remote Workspace' })
    expect(button).toHaveClass('h-8')
    expect(button).toHaveClass('rounded-[7px]')
    expect(button).toHaveClass('text-sm')
  })

  test('shows file hint when root tree has any entry', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })
    ;(remoteWorkspaceApis.getTree as jest.Mock).mockResolvedValue({
      path: '/workspace',
      entries: [
        {
          name: 'src',
          path: '/workspace/src',
          is_directory: true,
          size: 0,
        },
      ],
    })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    await waitFor(() => {
      expect(screen.getByTestId('remote-workspace-file-hint')).toHaveTextContent('Files')
    })
  })

  test('shows visible file hint inside icon button when root tree has entries', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })
    ;(remoteWorkspaceApis.getTree as jest.Mock).mockResolvedValue({
      path: '/workspace',
      entries: [
        {
          name: 'output',
          path: '/workspace/output',
          is_directory: true,
          size: 0,
        },
      ],
    })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" display="icon" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    await waitFor(() => {
      const button = screen.getByTestId('remote-workspace-button')
      expect(button).toHaveClass('min-w-[64px]')
      expect(screen.getByTestId('remote-workspace-file-hint')).toHaveTextContent('Files')
      expect(screen.getByTestId('remote-workspace-file-hint')).not.toHaveClass('absolute')
    })
  })

  test('hides file hint when root tree is empty', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })
    ;(remoteWorkspaceApis.getTree as jest.Mock).mockResolvedValue({
      path: '/workspace',
      entries: [],
    })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledWith(1, '/workspace')
    })

    expect(screen.queryByTestId('remote-workspace-file-hint')).not.toBeInTheDocument()
  })

  test('refreshes file hint after task status changes', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })
    ;(remoteWorkspaceApis.getTree as jest.Mock)
      .mockResolvedValueOnce({
        path: '/workspace',
        entries: [],
      })
      .mockResolvedValueOnce({
        path: '/workspace',
        entries: [
          {
            name: 'output',
            path: '/workspace/output',
            is_directory: true,
            size: 0,
          },
        ],
      })

    const { rerender } = render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByTestId('remote-workspace-file-hint')).not.toBeInTheDocument()

    rerender(<RemoteWorkspaceEntry taskId={1} taskStatus="COMPLETED" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByTestId('remote-workspace-file-hint')).toHaveTextContent('Files')
    })
  })

  test('refreshes file hint when refresh key changes without task status change', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })
    ;(remoteWorkspaceApis.getTree as jest.Mock)
      .mockResolvedValueOnce({
        path: '/workspace',
        entries: [],
      })
      .mockResolvedValueOnce({
        path: '/workspace',
        entries: [
          {
            name: 'result.html',
            path: '/workspace/result.html',
            is_directory: false,
            size: 128,
          },
        ],
      })

    const { rerender } = render(
      <RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" refreshKey="round-1" display="icon" />
    )

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByTestId('remote-workspace-file-hint')).not.toBeInTheDocument()

    rerender(
      <RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" refreshKey="round-2" display="icon" />
    )

    await waitFor(() => {
      expect(remoteWorkspaceApis.getTree).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByTestId('remote-workspace-file-hint')).toHaveTextContent('Files')
    })
  })

  test('keeps button visible and disabled when workspace is not connected', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock)
      .mockResolvedValueOnce({
        connected: false,
        available: false,
        root_path: '/workspace',
        reason: 'not_connected',
      })
      .mockResolvedValueOnce({
        connected: true,
        available: false,
        root_path: '/workspace',
        reason: 'warming',
      })

    const { rerender } = render(<RemoteWorkspaceEntry taskId={1} taskStatus="PENDING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      const disconnectedButton = screen.getByRole('button', { name: 'Remote Workspace' })
      expect(disconnectedButton).toBeDisabled()
      expect(disconnectedButton).toHaveAttribute('title', 'Remote session is not connected yet')
    })

    rerender(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeInTheDocument()
    })
  })

  test('disabled button becomes enabled when taskStatus changes', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock)
      .mockResolvedValueOnce({
        connected: true,
        available: false,
        root_path: '/workspace',
        reason: 'sandbox_not_running',
      })
      .mockResolvedValueOnce({
        connected: true,
        available: true,
        root_path: '/workspace',
        reason: null,
      })

    const { rerender } = render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeDisabled()
    })

    rerender(<RemoteWorkspaceEntry taskId={1} taskStatus="COMPLETED" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeEnabled()
    })
  })

  test('does not poll status on interval', async () => {
    jest.useFakeTimers()
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(1)
    })

    act(() => {
      jest.advanceTimersByTime(30000)
    })

    expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(1)
  })

  test('fetches new task status when task switches during in-flight request', async () => {
    type Deferred<T> = {
      promise: Promise<T>
      resolve: (value: T) => void
    }

    const createDeferred = <T,>(): Deferred<T> => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>(res => {
        resolve = res
      })
      return { promise, resolve }
    }

    const task1Deferred = createDeferred<{
      connected: boolean
      available: boolean
      root_path: string
      reason: string | null
    }>()
    const task2Deferred = createDeferred<{
      connected: boolean
      available: boolean
      root_path: string
      reason: string | null
    }>()

    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockImplementation((taskId: number) => {
      if (taskId === 1) {
        return task1Deferred.promise
      }
      return task2Deferred.promise
    })

    const { rerender } = render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledWith(1)
    })

    rerender(<RemoteWorkspaceEntry taskId={2} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledWith(2)
    })

    await act(async () => {
      task2Deferred.resolve({
        connected: true,
        available: true,
        root_path: '/workspace/2',
        reason: null,
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeEnabled()
    })

    await act(async () => {
      task1Deferred.resolve({
        connected: true,
        available: false,
        root_path: '/workspace/1',
        reason: 'sandbox_not_running',
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeEnabled()
    })
  })

  test('clears stale status immediately when switching to another task', async () => {
    type Deferred<T> = {
      promise: Promise<T>
      resolve: (value: T) => void
    }

    const createDeferred = <T,>(): Deferred<T> => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>(res => {
        resolve = res
      })
      return { promise, resolve }
    }

    const task2Deferred = createDeferred<{
      connected: boolean
      available: boolean
      root_path: string
      reason: string | null
    }>()

    ;(remoteWorkspaceApis.getStatus as jest.Mock)
      .mockResolvedValueOnce({
        connected: true,
        available: false,
        root_path: '/workspace/1',
        reason: 'sandbox_not_running',
      })
      .mockImplementationOnce(() => task2Deferred.promise)

    const { rerender } = render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeDisabled()
    })

    rerender(<RemoteWorkspaceEntry taskId={2} taskStatus="RUNNING" />)

    await waitFor(() => {
      const switchingButton = screen.getByRole('button', { name: 'Remote Workspace' })
      expect(switchingButton).toBeDisabled()
      expect(switchingButton).toHaveAttribute('title', 'Checking remote workspace status...')
    })

    await act(async () => {
      task2Deferred.resolve({
        connected: true,
        available: true,
        root_path: '/workspace/2',
        reason: null,
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeEnabled()
    })
  })

  test('retries unavailable status with bounded backoff and becomes enabled automatically', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock)
      .mockResolvedValueOnce({
        connected: true,
        available: false,
        root_path: '/workspace',
        reason: 'sandbox_not_running',
      })
      .mockResolvedValueOnce({
        connected: true,
        available: true,
        root_path: '/workspace',
        reason: null,
      })

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeDisabled()
    })

    await waitFor(
      () => {
        expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(2)
      },
      { timeout: 3000 }
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remote Workspace' })).toBeEnabled()
    })

    await new Promise(resolve => setTimeout(resolve, 1200))

    expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledTimes(2)
  })

  test('shows fallback reason when status check fails', async () => {
    ;(remoteWorkspaceApis.getStatus as jest.Mock).mockRejectedValue(new Error('network'))

    render(<RemoteWorkspaceEntry taskId={1} taskStatus="RUNNING" />)

    await waitFor(() => {
      expect(remoteWorkspaceApis.getStatus).toHaveBeenCalledWith(1)
    })

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Remote Workspace' })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', 'Failed to check remote workspace status')
    })
  })
})
