import { isRuntimeMyWorkItem } from './runtimeMyWork'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { getRuntimeTaskLifecycleKey } from '@/features/workbench/runtimeTaskLifecycle'
import { track } from '@/telemetry/client'
import { emptyTaskSearchFilters } from './taskSearch'
import { projectSpaceKey, projectSpaceRef, sameProjectSpace } from './projectSpaceSelection'
import type { RuntimeProjectSpaceRef, RuntimeTaskAddress } from '@/types/api'
import type { CloudTodoWorkspaceObservation } from './cloudTodoWorkspaceObservation'
import type { createCloudTodoWorkspaceState } from './cloudTodoWorkspaceState'
import type { LocatedLoopItem } from './cloudTodoWorkspaceTypes'
export function createCloudTodoWorkspaceNavigation(
  state: ReturnType<typeof createCloudTodoWorkspaceState>
) {
  let current: CloudTodoWorkspaceObservation | undefined
  let locallyRequested: RuntimeProjectSpaceRef | null | undefined
  let controlledKey: string | null | undefined
  let focusedRequest: string | null = null
  let defaultNotification: string | null = null
  let cloudItems: unknown
  let cloudProject: unknown
  let selectedProject: unknown
  let startupReady = false
  let trackedView: string | null = null
  let quickAddSequence = 0
  const reset = () => {
    state.update({
      projectView: 'board',
      boardParentId: null,
      projectSearchOpen: false,
      projectSearchQuery: '',
      projectSearchFilters: emptyTaskSearchFilters,
      localExternalPageLoading: {},
    })
    current?.board.state.setGroupFilter('')
    current?.board.state.setQuery('')
  }
  const markRead = (item: LocatedLoopItem, input: CloudTodoWorkspaceObservation) => {
    if (!input.props.onMarkRuntimeTaskRead) return
    if (isRuntimeMyWorkItem(item)) {
      const address = item.runtime_address
      if (input.props.runtimeTaskLifecycle?.unreadTaskKeys.has(getRuntimeTaskLifecycleKey(address)))
        input.props.onMarkRuntimeTaskRead(address)
      return
    }
    const addresses = new Map<string, RuntimeTaskAddress>()
    for (const binding of input.taskBindings[item.id] ?? []) {
      const address = { deviceId: binding.device_id, taskId: binding.task_id }
      addresses.set(getRuntimeTaskLifecycleKey(address), address)
    }
    for (const address of input.runtimeAddressesByWorkItem.get(
      `${item.cloud_project_id}:${item.id}`
    ) ?? [])
      addresses.set(getRuntimeTaskLifecycleKey(address), address)
    for (const address of addresses.values())
      if (input.props.runtimeTaskLifecycle?.unreadTaskKeys.has(getRuntimeTaskLifecycleKey(address)))
        input.props.onMarkRuntimeTaskRead(address)
  }
  return {
    reset,
    rememberProjectRequest(ref: RuntimeProjectSpaceRef | null) {
      locallyRequested = ref
    },
    nextQuickAddId: () => ++quickAddSequence,
    advanceTaskPanelSession() {
      const next = state.getSnapshot().taskPanelSessionId + 1
      state.setTaskPanelSessionId(next)
      return next
    },
    observe(input: CloudTodoWorkspaceObservation) {
      current = input
      if (input.activeProjectKey !== undefined && controlledKey !== input.activeProjectKey) {
        controlledKey = input.activeProjectKey
        const localKey =
          locallyRequested === undefined
            ? undefined
            : locallyRequested
              ? projectSpaceKey(locallyRequested)
              : null
        if (localKey === controlledKey) locallyRequested = undefined
        else reset()
      }
      const defaultProject = input.requestedProjectRef === null ? input.defaultProject : null
      const defaultKey = defaultProject ? projectSpaceKey(projectSpaceRef(defaultProject)) : null
      if (defaultKey !== defaultNotification) {
        defaultNotification = defaultKey
        if (defaultProject) input.props.onActiveProjectChange?.(defaultProject)
      }
      const project = input.project
      const projectKey = project ? projectSpaceKey(projectSpaceRef(project)) : null
      const cloud = input.cloud.state
      if (
        cloudItems !== cloud.issues ||
        cloudProject !== cloud.project?.id ||
        selectedProject !== project
      ) {
        cloudItems = cloud.issues
        cloudProject = cloud.project?.id
        selectedProject = project
        if (project?.location === 'cloud' && cloud.project?.id === String(project.id)) {
          const visible = cloud.issues.map(
            item => ({ ...item, project_store: project.project_store }) as LocatedLoopItem
          )
          state.setSelectedItem(previous =>
            previous &&
            sameProjectSpace(
              {
                projectStore: previous.project_store ?? project.project_store,
                projectId: previous.cloud_project_id,
              },
              projectSpaceRef(project)
            )
              ? (visible.find(item => item.id === previous.id) ?? null)
              : previous
          )
        }
      }
      const focused = input.props.focusedItemId
      if (!focused) focusedRequest = null
      else if (
        project &&
        projectKey &&
        (project.location === 'cloud'
          ? cloud.project?.id === String(project.id)
          : state.getSnapshot().itemsProjectKey === projectKey)
      ) {
        const key = `${projectKey}:${focused}`
        const item = input.sourceItems.find(candidate => candidate.id === focused)
        if (focusedRequest !== key && item && item.can_view_detail !== false) {
          focusedRequest = key
          if (isDefaultWorkItemProject(project)) markRead(item, input)
          state.update({ projectView: 'board', boardParentId: item.parent_id, selectedItem: item })
          input.props.onFocusedItemHandled?.()
        }
      }
      const viewKey =
        project && projectKey ? `${projectKey}:${state.getSnapshot().projectView}` : null
      if (viewKey && viewKey !== trackedView) {
        trackedView = viewKey
        track('board_view_opened', {
          source: project!.location,
          view: state.getSnapshot().projectView,
        })
      }
      if (input.startupReady !== startupReady) {
        startupReady = input.startupReady
        if (startupReady && isElectronRuntime() && getDesktopWindowLabel() === 'main')
          void invokeDesktopHost<void>('renderer.startupReady').catch(error =>
            console.error('[Wework] Failed to reveal the ready project space', error)
          )
      }
    },
    stop() {
      current = undefined
      startupReady = false
    },
  }
}
