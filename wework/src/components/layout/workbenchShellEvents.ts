import { useEffect } from 'react'
import type { ProjectCreateMode } from '@/components/chat/ChatInput'
import type { ProjectWithTasks } from '@/types/api'

const OPEN_PROJECT_CREATE_EVENT = 'wework:open-project-create'
const BIND_PROJECT_WORKSPACE_EVENT = 'wework:bind-project-workspace'
const OPEN_CLOUD_DEVICE_SETTINGS_EVENT = 'wework:open-cloud-device-settings'

export interface ProjectCreateRequestOptions {
  preserveCurrentSurface?: boolean
  onCreated?: (project: ProjectWithTasks) => void
}

export function requestProjectCreateMode(
  mode: ProjectCreateMode,
  options?: ProjectCreateRequestOptions
) {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_CREATE_EVENT, { detail: { mode, options } }))
}

export function requestProjectWorkspaceBinding(projectId: number) {
  window.dispatchEvent(new CustomEvent(BIND_PROJECT_WORKSPACE_EVENT, { detail: { projectId } }))
}

export function requestOpenCloudDeviceSettings() {
  window.dispatchEvent(new CustomEvent(OPEN_CLOUD_DEVICE_SETTINGS_EVENT))
}

export function useWorkbenchShellEventHandlers({
  enabled,
  onCreateProjectMode,
  onBindProjectWorkspace,
  onOpenCloudDeviceSettings,
}: {
  enabled: boolean
  onCreateProjectMode: (mode: ProjectCreateMode, options?: ProjectCreateRequestOptions) => void
  onBindProjectWorkspace: (projectId: number) => void
  onOpenCloudDeviceSettings: () => void
}) {
  useEffect(() => {
    if (!enabled) return
    const handleOpenProjectCreate = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          mode?: ProjectCreateMode
          options?: ProjectCreateRequestOptions
        }>
      ).detail
      const mode = detail?.mode
      if (mode) {
        onCreateProjectMode(mode, detail.options)
      }
    }
    const handleBindProjectWorkspace = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: number }>).detail?.projectId
      if (typeof projectId === 'number') {
        onBindProjectWorkspace(projectId)
      }
    }

    window.addEventListener(OPEN_PROJECT_CREATE_EVENT, handleOpenProjectCreate)
    window.addEventListener(BIND_PROJECT_WORKSPACE_EVENT, handleBindProjectWorkspace)
    window.addEventListener(OPEN_CLOUD_DEVICE_SETTINGS_EVENT, onOpenCloudDeviceSettings)

    return () => {
      window.removeEventListener(OPEN_PROJECT_CREATE_EVENT, handleOpenProjectCreate)
      window.removeEventListener(BIND_PROJECT_WORKSPACE_EVENT, handleBindProjectWorkspace)
      window.removeEventListener(OPEN_CLOUD_DEVICE_SETTINGS_EVENT, onOpenCloudDeviceSettings)
    }
  }, [enabled, onBindProjectWorkspace, onCreateProjectMode, onOpenCloudDeviceSettings])
}
