import { useEffect } from 'react'
import type { ProjectCreateMode } from '@/components/chat/ChatInput'

const OPEN_PROJECT_CREATE_EVENT = 'wework:open-project-create'
const BIND_PROJECT_WORKSPACE_EVENT = 'wework:bind-project-workspace'
const OPEN_CLOUD_DEVICE_SETTINGS_EVENT = 'wework:open-cloud-device-settings'

export function requestProjectCreateMode(mode: ProjectCreateMode) {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_CREATE_EVENT, { detail: { mode } }))
}

export function requestProjectWorkspaceBinding(projectId: number) {
  window.dispatchEvent(new CustomEvent(BIND_PROJECT_WORKSPACE_EVENT, { detail: { projectId } }))
}

export function requestOpenCloudDeviceSettings() {
  window.dispatchEvent(new CustomEvent(OPEN_CLOUD_DEVICE_SETTINGS_EVENT))
}

export function useWorkbenchShellEventHandlers({
  onCreateProjectMode,
  onBindProjectWorkspace,
  onOpenCloudDeviceSettings,
}: {
  onCreateProjectMode: (mode: ProjectCreateMode) => void
  onBindProjectWorkspace: (projectId: number) => void
  onOpenCloudDeviceSettings: () => void
}) {
  useEffect(() => {
    const handleOpenProjectCreate = (event: Event) => {
      const mode = (event as CustomEvent<{ mode?: ProjectCreateMode }>).detail?.mode
      if (mode) {
        onCreateProjectMode(mode)
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
  }, [onBindProjectWorkspace, onCreateProjectMode, onOpenCloudDeviceSettings])
}
