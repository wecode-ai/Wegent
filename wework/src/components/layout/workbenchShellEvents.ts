import { useDOMEvent } from '@wegent/collaboration/dom-events'
import type { ProjectCreateMode } from '@/components/chat/ChatInput'
import type { ProjectWithTasks } from '@/types/api'

const OPEN_PROJECT_CREATE_EVENT = 'wework:open-project-create'
const BIND_PROJECT_WORKSPACE_EVENT = 'wework:bind-project-workspace'
const OPEN_CLOUD_DEVICE_SETTINGS_EVENT = 'wework:open-cloud-device-settings'
const OPEN_TASK_SEARCH_EVENT = 'wework:open-task-search'

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

export function requestOpenTaskSearch() {
  window.dispatchEvent(new CustomEvent(OPEN_TASK_SEARCH_EVENT))
}

export function useWorkbenchShellEventHandlers({
  enabled,
  onCreateProjectMode,
  onBindProjectWorkspace,
  onOpenCloudDeviceSettings,
  onOpenTaskSearch,
}: {
  enabled: boolean
  onCreateProjectMode: (mode: ProjectCreateMode, options?: ProjectCreateRequestOptions) => void
  onBindProjectWorkspace: (projectId: number) => void
  onOpenCloudDeviceSettings: () => void
  onOpenTaskSearch: () => void
}) {
  useDOMEvent(
    'window',
    OPEN_PROJECT_CREATE_EVENT,
    event => {
      const detail = (
        event as CustomEvent<{ mode?: ProjectCreateMode; options?: ProjectCreateRequestOptions }>
      ).detail
      if (detail?.mode) onCreateProjectMode(detail.mode, detail.options)
    },
    { enabled }
  )
  useDOMEvent(
    'window',
    BIND_PROJECT_WORKSPACE_EVENT,
    event => {
      const projectId = (event as CustomEvent<{ projectId?: number }>).detail?.projectId
      if (typeof projectId === 'number') onBindProjectWorkspace(projectId)
    },
    { enabled }
  )
  useDOMEvent('window', OPEN_CLOUD_DEVICE_SETTINGS_EVENT, onOpenCloudDeviceSettings, { enabled })
  useDOMEvent('window', OPEN_TASK_SEARCH_EVENT, onOpenTaskSearch, { enabled })
}
