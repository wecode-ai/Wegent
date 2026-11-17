import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceInfo, RuntimeDeviceWorkspace } from '@/types/runtime'
import {
  worktreeCapability,
  worktreeDevice,
  worktreePreflight,
  worktreeWorkspace,
} from '@/testing/worktreeFixtures'
import { useWorkspaceWorktree, type WorkspaceWorktreeApi } from './useWorkspaceWorktree'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('mobile uses PC worktree availability on the selected owner', () => {
  let renderer: ReactTestRenderer
  let state: ReturnType<typeof useWorkspaceWorktree>
  const api = () =>
    ({
      getWorktreeCapabilities: vi.fn(async ({ deviceId }) => ({
        success: true,
        deviceId,
        runtimeWorktrees: worktreeCapability,
      })),
      preflightWorkspace: vi.fn(async () => worktreePreflight()),
    }) satisfies WorkspaceWorktreeApi
  function Harness({
    service,
    workspace = worktreeWorkspace,
    devices = [worktreeDevice],
    enabled = true,
    branch = null,
  }: {
    service: WorkspaceWorktreeApi
    workspace?: RuntimeDeviceWorkspace
    devices?: DeviceInfo[]
    enabled?: boolean
    branch?: string | null
  }) {
    state = useWorkspaceWorktree(service, enabled, workspace, devices, branch)
    return null
  }
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    vi.restoreAllMocks()
  })

  it.each(['cloud', 'app', 'local'] as const)(
    'probes %s capabilities before preflight and keeps equivalent objects stable',
    async kind => {
      const service = api()
      service.preflightWorkspace.mockResolvedValue(
        worktreePreflight({ gitRef: 'release', currentBranch: 'main' })
      )
      const device: DeviceInfo = {
        ...worktreeDevice,
        device_type: kind,
        execution_target_id: 'cloud',
        runtime_features: {
          ...worktreeDevice.runtime_features!,
          embeddedRuntime: kind === 'local' ? {} : null,
          remoteTaskAccess: { version: 1, enabled: true, taskCreation: true },
        },
      }
      await act(() => {
        renderer = create(<Harness service={service} devices={[device]} branch="release" />)
      })
      expect(state.availability.available).toBe(true)
      expect(state.currentBranch).toBe('main')
      expect(service.getWorktreeCapabilities).toHaveBeenCalledExactlyOnceWith({ deviceId: 'cloud' })
      expect(service.preflightWorkspace).toHaveBeenCalledExactlyOnceWith({
        deviceId: 'cloud',
        sourcePath: '/workspace/repo',
        ref: 'release',
      })
      expect(service.getWorktreeCapabilities.mock.invocationCallOrder[0]).toBeLessThan(
        service.preflightWorkspace.mock.invocationCallOrder[0]!
      )
      await act(() =>
        renderer.update(
          <Harness
            service={service}
            devices={[{ ...device }]}
            workspace={{ ...worktreeWorkspace }}
            branch="release"
          />
        )
      )
      expect(service.preflightWorkspace).toHaveBeenCalledOnce()
    }
  )

  it.each([
    [{ gitRepository: false }, 'not_git'],
    [{ gitCommonDirWritable: false }, 'worktree_root_unwritable'],
    [{ repoRootFingerprint: 'changed' }, 'workspace_identity_mismatch'],
  ] as const)('preserves the PC preflight failure %s', async (override, reason) => {
    const service = api()
    service.preflightWorkspace.mockResolvedValue(worktreePreflight(override))
    await act(() => {
      renderer = create(<Harness service={service} />)
    })
    expect(state.availability).toMatchObject({ available: false, reason })
  })

  it('uses the remote workspace owner and ignores a late response after switching workspace', async () => {
    const service = api()
    let finish!: (value: ReturnType<typeof worktreePreflight>) => void
    service.preflightWorkspace.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const remoteWorkspace = {
      ...worktreeWorkspace,
      deviceId: 'execution',
      workspaceSource: 'remote',
      remoteHostId: 'cloud',
    }
    await act(() => {
      renderer = create(<Harness service={service} workspace={remoteWorkspace} />)
    })
    expect(service.preflightWorkspace).toHaveBeenCalledWith({
      deviceId: 'cloud',
      sourcePath: '/workspace/repo',
    })
    const nextWorkspace = { ...worktreeWorkspace, workspacePath: '/workspace/next' }
    service.preflightWorkspace.mockResolvedValue(worktreePreflight({ currentBranch: 'next' }))
    await act(() => renderer.update(<Harness service={service} workspace={nextWorkspace} />))
    expect(state.currentBranch).toBe('next')
    await act(() => finish(worktreePreflight({ currentBranch: 'old' })))
    expect(state.currentBranch).toBe('next')
  })

  it('retains the original read error and retries only on request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('Unavailable')
    const service = api()
    service.preflightWorkspace.mockRejectedValueOnce(failure)
    await act(() => {
      renderer = create(<Harness service={service} />)
    })
    expect(state.availability.reason).toBe('preflight_failed')
    expect(state.error).toBe(failure)
    expect(service.preflightWorkspace).toHaveBeenCalledOnce()
    await act(() => state.retry())
    expect(state.availability.available).toBe(true)
    expect(state.error).toBeNull()
  })

  it('does not discover configuration for an inactive or existing conversation or a worktree source', async () => {
    const service = api()
    await act(() => {
      renderer = create(<Harness service={service} enabled={false} />)
    })
    expect(service.getWorktreeCapabilities).not.toHaveBeenCalled()
    await act(() =>
      renderer.update(
        <Harness
          service={service}
          workspace={{ ...worktreeWorkspace, workspaceKind: 'worktree', worktreeId: 'existing' }}
        />
      )
    )
    expect(state.availability.reason).toBe('workspace_not_base')
    expect(service.getWorktreeCapabilities).not.toHaveBeenCalled()
    await act(() =>
      renderer.update(
        <Harness service={service} devices={[{ ...worktreeDevice, status: 'offline' }]} />
      )
    )
    expect(state.availability.available).toBe(false)
    expect(state.availability.reason).toBe('device_offline')
    expect(service.getWorktreeCapabilities).not.toHaveBeenCalled()
  })
})
