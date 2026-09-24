import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceCommandResponse } from '@/types/api'
import type { DeviceCommandApi } from '@/api/environment'
import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'
import {
  ChangeRequestMonitor,
  runtimeTaskChangeRequestTarget,
  useTaskChangeRequest,
} from './changeRequestMonitor'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('runtimeTaskChangeRequestTarget', () => {
  it('uses the runtime current branch when registering a PR lookup target', () => {
    const workspace = {
      deviceId: 'local-device',
      workspacePath: '/repo',
      repoUrl: 'https://github.com/wecode-ai/Wegent.git',
      tasks: [],
    } as RuntimeDeviceWorkspace
    const task = {
      taskId: 'runtime-1',
      title: 'Fix status',
      runtime: 'codex',
      workspacePath: '/repo/worktrees/runtime-1',
      gitInfo: {
        branch: 'main',
        currentBranch: 'fix/pr-status',
        originUrl: 'https://github.com/wecode-ai/Wegent.git',
      },
    } as RuntimeTaskSummary

    expect(runtimeTaskChangeRequestTarget(workspace, task)).toEqual({
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo/worktrees/runtime-1',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    })
  })
})

describe('ChangeRequestMonitor', () => {
  it('does not refresh again when an equivalent hook target is recreated', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockResolvedValue({ success: true, stdout: [] })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const target = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    }
    const { rerender, unmount } = renderHook(
      ({ currentTarget }) => useTaskChangeRequest(monitor, currentTarget),
      { initialProps: { currentTarget: target } }
    )
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))

    rerender({ currentTarget: { ...target } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(executeCommand).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('shares the initial refresh for duplicate target registrations', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockResolvedValue({ success: true, stdout: [] })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const target = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    }

    const unregisterFirst = monitor.register(target)
    const unregisterSecond = monitor.register({ ...target, taskId: 'runtime-2' })
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))

    unregisterSecond()
    unregisterFirst()
  })

  it('queues a fresh request after an in-flight request for explicit refreshes', async () => {
    const firstResponse = deferred<DeviceCommandResponse>()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue({ success: true, stdout: [] })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const unregister = monitor.register({
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    })
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))

    const refresh = monitor.refresh({ shareInflight: false })
    firstResponse.resolve({ success: true, stdout: [] })
    await refresh

    expect(executeCommand).toHaveBeenCalledTimes(2)
    unregister()
  })

  it('keeps structured lookup failures when preserving a previous snapshot', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockResolvedValueOnce({ success: true, stdout: [] })
      .mockResolvedValueOnce({
        success: false,
        stdout: '',
        stderr: 'gh: command not found',
      })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const target = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    }
    const unregister = monitor.register(target)
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))

    await monitor.refresh()

    expect(monitor.getSnapshot(target)).toMatchObject({
      provider: 'github',
      lookupState: 'unavailable',
      stale: true,
      error: 'gh: command not found',
    })
    unregister()
  })
})
