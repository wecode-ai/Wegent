import { useEffect, useRef, useState } from 'react'
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

export function useProjectWorktreeAvailabilityProbe({
  api,
  device,
  enabled,
  key,
  project,
  ref,
  workspace,
}: ProjectWorktreeAvailabilityProbeInput): ProjectWorktreeAvailabilityProbe | null {
  const [probe, setProbe] = useState<ProjectWorktreeAvailabilityProbe | null>(null)
  const probeSequence = useRef(0)
  const inputRef = useRef({ device, project, ref, workspace })

  useEffect(() => {
    inputRef.current = { device, project, ref, workspace }
  }, [device, project, ref, workspace])

  useEffect(() => {
    if (!enabled || !api) return

    const input = inputRef.current
    if (!input.project || !input.workspace || !input.device) return

    const sequence = probeSequence.current + 1
    probeSequence.current = sequence
    let cancelled = false
    void probeProjectWorktreeAvailability({
      api,
      project: input.project,
      workspace: input.workspace,
      device: input.device,
      ref: input.ref,
    }).then(availability => {
      if (!cancelled && probeSequence.current === sequence) {
        setProbe({ key, availability })
      }
    })

    return () => {
      cancelled = true
    }
  }, [api, enabled, key])

  return probe
}
