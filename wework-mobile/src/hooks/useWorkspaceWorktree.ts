import { useEffect, useState } from 'react'

import { mobileOperableDevices } from '@/domain/deviceOrdering'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, RuntimeDeviceWorkspace } from '@/types/runtime'
import {
  probeWorkspaceWorktreeAvailability,
  resolveWorkspaceWorktreeAvailability,
  worktreeWorkspaceDeviceId,
  type ProjectWorktreeAvailability,
} from '../../../packages/chat-core/src/worktree-availability'

export type WorkspaceWorktreeApi = Pick<
  RuntimeApi,
  'getWorktreeCapabilities' | 'preflightWorkspace'
>

interface WorktreeSnapshot {
  key: string
  workspaceKey: string
  availability: ProjectWorktreeAvailability
  currentBranch: string | null
  error: unknown
}

export function useWorkspaceWorktree(
  api: WorkspaceWorktreeApi,
  enabled: boolean,
  workspace: RuntimeDeviceWorkspace | null,
  devices: DeviceInfo[],
  branch: string | null
) {
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot | null>(null)
  const [revision, setRevision] = useState(0)
  const deviceId = worktreeWorkspaceDeviceId(workspace)
  const device = mobileOperableDevices(devices).find(
    item =>
      item.device_id === deviceId ||
      item.runtime_routes?.some(route => route.device_id === deviceId)
  )
  const workspaceKey = JSON.stringify([
    workspace?.deviceId,
    deviceId,
    workspace?.workspacePath,
    workspace?.repoRootFingerprint,
  ])
  const key = JSON.stringify([
    workspaceKey,
    enabled,
    branch,
    revision,
    workspace?.available,
    workspace?.workspaceKind,
    workspace?.worktreeId,
    device?.device_id,
    device?.status,
    device?.runtime_routes,
    device?.runtime_features?.worktrees,
  ])
  const initial = resolveWorkspaceWorktreeAvailability({ workspace, device })

  useEffect(() => {
    if (!enabled || !workspace || !device) return
    let active = true
    let currentBranch: string | null = null
    let error: unknown = null
    const recordFailure = (cause: unknown): never => {
      error = cause
      throw cause
    }
    void probeWorkspaceWorktreeAvailability({
      api: {
        getWorktreeCapabilities: input => api.getWorktreeCapabilities(input).catch(recordFailure),
        preflightWorktree: async input => {
          const result = await api.preflightWorkspace(input).catch(recordFailure)
          if (result.error) error = result
          currentBranch = result.gitRepository ? (result.currentBranch ?? null) : null
          return result
        },
      },
      workspace,
      device,
      ref: branch,
    }).then(availability => {
      if (active) setSnapshot({ key, workspaceKey, availability, currentBranch, error })
    })
    return () => {
      active = false
    }
    // The key includes protocol identity and capability fields, not object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key])

  return {
    availability: enabled && snapshot?.key === key ? snapshot.availability : initial,
    currentBranch: snapshot?.workspaceKey === workspaceKey ? snapshot.currentBranch : null,
    error: snapshot?.key === key ? snapshot.error : null,
    retry: () => setRevision(value => value + 1),
  }
}
