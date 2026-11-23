import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { DeviceInfo, ProjectWithTasks, RuntimeDeviceWorkspace } from '@/types/api'
import {
  probeProjectWorktreeAvailability,
  type ProjectWorktreeAvailability,
  type ProjectWorktreeAvailabilityApi,
} from '@/lib/worktree-availability'

interface ProjectWorktreeAvailabilityProbeInput {
  api: ProjectWorktreeAvailabilityApi | null | undefined
  device: DeviceInfo | null
  enabled: boolean
  key: string
  project: ProjectWithTasks | null
  ref?: string | null
  workspace: RuntimeDeviceWorkspace | null
}

interface ProjectWorktreeAvailabilityProbe {
  key: string
  availability: ProjectWorktreeAvailability
}

function createProbeResource(api: ProjectWorktreeAvailabilityProbeInput['api'], key: string) {
  let input:
    | Pick<ProjectWorktreeAvailabilityProbeInput, 'device' | 'project' | 'ref' | 'workspace'>
    | undefined
  const resource = createAsyncResource<ProjectWorktreeAvailabilityProbe | null>(
    key,
    async () => {
      if (!api || !input?.device || !input.project || !input.workspace) return null
      return { key, availability: await probeProjectWorktreeAvailability({ api, ...input }) }
    },
    { refreshOnSubscribe: true }
  )
  return {
    ...resource,
    subscribe(listener: () => void, next: NonNullable<typeof input>) {
      input = next
      return resource.subscribe(listener)
    },
  }
}

export function useProjectWorktreeAvailabilityProbe({
  api,
  device,
  enabled,
  key,
  project,
  ref,
  workspace,
}: ProjectWorktreeAvailabilityProbeInput): ProjectWorktreeAvailabilityProbe | null {
  // Equivalent polling snapshots keep the same request; activation captures the latest input.
  const [scope, setScope] = useState(() => ({
    api,
    key,
    enabled,
    input: { device, project, ref, workspace },
  }))
  if (scope.api !== api || scope.key !== key || scope.enabled !== enabled)
    setScope({ api, key, enabled, input: { device, project, ref, workspace } })
  const resource = useMemo(() => createProbeResource(api, key), [api, key])
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, scope.input),
    [resource, scope]
  )
  const query = useSyncExternalStore(
    enabled && api ? subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  return query.data ?? null
}
