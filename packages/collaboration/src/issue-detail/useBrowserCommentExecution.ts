import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DeviceInfo } from '@wegent/chat-core/execution-project'
import type {
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@wegent/chat-core/runtime-task-api-types'
import type { UnifiedModel } from '@wegent/chat-core/models'
import { getPreferredStandaloneDeviceId } from '@wegent/chat-core/device-selection'
import { runtimeProjectToProject, runtimeProjectUiId } from '@wegent/chat-core/runtime-project'
import { isSelectableProjectWorkspace } from '@wegent/chat-core/project-workspace-selection'
import type { CommentExecutionTarget } from '../execution/httpCommentRuntime'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'

/** Resolve the selected code workspace independently of the Issue's storage and assignee. */
export function useBrowserCommentExecution(runtime: SharedWorkspaceRuntimeApi) {
  const [revision, setRevision] = useState(0)
  const [catalog, setCatalog] = useState<{
    revision: number
    devices: DeviceInfo[]
    work: RuntimeWorkListResponse
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<{
    projectId: number
    workspace?: RuntimeDeviceWorkspace
  } | null>(null)
  const [models, setModels] = useState<{ deviceId: string; items: UnifiedModel[] } | null>(null)
  const [modelError, setModelError] = useState<{ deviceId: string; message: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      runtime.listDevices(),
      runtime.work.listRuntimeWork({ signal: controller.signal }),
    ])
      .then(([devices, work]) => {
        if (!controller.signal.aborted) {
          setCatalog({ devices, work, revision })
          setError(null)
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [runtime, revision])
  // APP devices are visible in the account catalog, but the backend does not
  // allow remote control of their runtime from a browser.
  const work = useMemo(() => {
    if (!catalog) return undefined
    const appDeviceIds = new Set(
      catalog.devices.filter(device => device.device_type === 'app').map(device => device.device_id)
    )
    return {
      ...catalog.work,
      projects: catalog.work.projects.map(project => ({
        ...project,
        deviceWorkspaces: project.deviceWorkspaces.map(workspace =>
          appDeviceIds.has(workspace.deviceId) ? { ...workspace, available: false } : workspace
        ),
      })),
    }
  }, [catalog])
  const projects = useMemo(() => (work?.projects ?? []).map(runtimeProjectToProject), [work])
  const projectWork = selection
    ? work?.projects.find(item => runtimeProjectUiId(item.project) === selection.projectId)
    : undefined
  const workspace = selection?.workspace
    ? projectWork?.deviceWorkspaces.find(
        item =>
          item.deviceId === selection.workspace?.deviceId &&
          item.workspacePath === selection.workspace.workspacePath
      )
    : projectWork?.deviceWorkspaces.length === 1
      ? projectWork.deviceWorkspaces[0]
      : null
  const standaloneDeviceId = getPreferredStandaloneDeviceId(
    (catalog?.devices ?? []).filter(device => device.device_type !== 'app'),
    catalog?.devices.find(device => device.is_default)?.device_id
  )
  const standaloneTarget = useMemo<CommentExecutionTarget | null>(
    () => (standaloneDeviceId ? { deviceId: standaloneDeviceId, runtime: 'codex' } : null),
    [standaloneDeviceId]
  )
  const deviceId = selection
    ? workspace && isSelectableProjectWorkspace(workspace, catalog?.devices)
      ? workspace.deviceId
      : null
    : standaloneDeviceId
  const target = useMemo<CommentExecutionTarget | null>(() => {
    if (!deviceId) return null
    return {
      deviceId,
      runtime: 'codex',
      ...(workspace && projectWork
        ? {
            ...(projectWork.project.id != null ? { projectId: projectWork.project.id } : {}),
            ...(workspace.id != null ? { deviceWorkspaceId: workspace.id } : {}),
            workspacePath: workspace.workspacePath,
            runtimeProjectKey: projectWork.project.key,
            runtimeProjectName: projectWork.project.name,
            runtimeWorkspaceRoots: projectWork.project.roots?.map(root => root.path),
          }
        : {}),
    }
  }, [deviceId, workspace, projectWork])
  useEffect(() => {
    let active = true
    if (deviceId)
      void runtime
        .listModels(deviceId)
        .then(items => {
          if (active) {
            setModels({ deviceId, items })
            setModelError(null)
          }
        })
        .catch(cause => {
          if (active)
            setModelError({
              deviceId,
              message: cause instanceof Error ? cause.message : String(cause),
            })
        })
    return () => {
      active = false
    }
  }, [runtime, deviceId, revision])
  return {
    devices: catalog?.devices ?? [],
    work,
    projects,
    selection,
    currentProject: projects.find(project => project.id === selection?.projectId) ?? null,
    workspace,
    target,
    standaloneTarget,
    error: error ?? (modelError?.deviceId === deviceId ? modelError.message : null),
    catalogError: error,
    loading: !catalog && !error,
    catalogCurrent: catalog?.revision === revision,
    models: models?.deviceId === deviceId ? models.items : [],
    modelsReady: models?.deviceId === deviceId,
    retry: useCallback(() => setRevision(value => value + 1), []),
    selectProject: (projectId: number | null, workspace?: RuntimeDeviceWorkspace) =>
      setSelection(projectId == null ? null : { projectId, workspace }),
  }
}
