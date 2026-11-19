import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { getIdleResourceSnapshot, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { createBrowserCommentExecutionResources } from './browserCommentExecutionResources'
import type { RuntimeDeviceWorkspace } from '@wegent/chat-core/runtime-task-api-types'
import { getPreferredStandaloneDeviceId } from '@wegent/chat-core/device-selection'
import { runtimeProjectToProject, runtimeProjectUiId } from '@wegent/chat-core/runtime-project'
import { isSelectableProjectWorkspace } from '@wegent/chat-core/project-workspace-selection'
import type { CommentExecutionTarget } from '../execution/httpCommentRuntime'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'

/** Resolve the selected code workspace independently of the Issue's storage and assignee. */
export function useBrowserCommentExecution(runtime: SharedWorkspaceRuntimeApi) {
  const owner = useMemo(() => createBrowserCommentExecutionResources(runtime), [runtime])
  const catalogSnapshot = useSyncExternalStore(
    owner.catalog.subscribe,
    owner.catalog.getSnapshot,
    owner.catalog.getSnapshot
  )
  const catalog = catalogSnapshot.data
  const catalogError =
    catalogSnapshot.status === 'error'
      ? catalogSnapshot.error instanceof Error
        ? catalogSnapshot.error.message
        : String(catalogSnapshot.error)
      : null
  const [choice, setChoice] = useState<{
    owner: typeof owner
    selection: { projectId: number; workspace?: RuntimeDeviceWorkspace } | null
  }>({ owner, selection: null })
  if (choice.owner !== owner) setChoice({ owner, selection: null })
  const selection = choice.owner === owner ? choice.selection : null
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
  const modelsResource = useMemo(
    () => (deviceId ? owner.modelsFor(deviceId) : null),
    [owner, deviceId]
  )
  const modelsSnapshot = useSyncExternalStore(
    modelsResource?.subscribe ?? subscribeIdleResource,
    modelsResource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const modelError =
    modelsSnapshot.status === 'error'
      ? modelsSnapshot.error instanceof Error
        ? modelsSnapshot.error.message
        : String(modelsSnapshot.error)
      : null
  const selectProject = useCallback(
    (projectId: number | null, workspace?: RuntimeDeviceWorkspace) => {
      setChoice(current =>
        current.owner === owner
          ? { owner, selection: projectId == null ? null : { projectId, workspace } }
          : current
      )
    },
    [owner]
  )
  return {
    devices: catalog?.devices ?? [],
    work,
    projects,
    selection,
    currentProject: projects.find(project => project.id === selection?.projectId) ?? null,
    workspace,
    target,
    standaloneTarget,
    error: catalogError ?? modelError,
    catalogError,
    loading: !catalog && !catalogError,
    catalogCurrent: catalogSnapshot.status === 'ready',
    models: modelsSnapshot.data ?? [],
    modelsReady: modelsSnapshot.status === 'ready',
    retry: owner.retry,
    selectProject,
  }
}
