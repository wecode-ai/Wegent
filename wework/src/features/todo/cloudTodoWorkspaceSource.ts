import { startBackgroundTask } from './backgroundTaskCommand'
import { sameProjectSpace, projectSpaceRef } from './projectSpaceSelection'
import type { LocatedCloudProject } from './cloudTodoWorkspaceTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { CloudTodoWorkspaceProps } from './cloudTodoWorkspaceTypes'
import { createCloudTodoBoardMutations } from './cloudTodoBoardMutations'
import { createCloudTodoWorkspaceState } from './cloudTodoWorkspaceState'
import { createCloudTodoLocalBoard } from './cloudTodoLocalBoard'
import { createCloudTodoProjectResources } from './cloudTodoProjectResources'
import { createCloudTodoWorkspaceNavigation } from './cloudTodoWorkspaceNavigation'
import { createCloudTodoChangeRequestRepair } from './cloudTodoChangeRequestRepair'
import type { CloudTodoWorkspaceObservation } from './cloudTodoWorkspaceObservation'
interface WorkspaceOwner {
  userId: CloudTodoWorkspaceProps['user']['id']
  cloudApi: WorkbenchServices['sharedWorkspaceApi']
  catalogApi: NonNullable<WorkbenchServices['projectSpaceApis']>['local']
  localApi: WorkbenchServices['deliveryApi']
}
export function createCloudTodoWorkspaceSource(owner: WorkspaceOwner) {
  const state = createCloudTodoWorkspaceState(Boolean(owner.catalogApi))
  const board = createCloudTodoLocalBoard(state)
  const resources = createCloudTodoProjectResources(state)
  const navigation = createCloudTodoWorkspaceNavigation(state)
  const repair = createCloudTodoChangeRequestRepair()
  const observers = new Set<() => void>()
  let admittedBackgroundRequest: number | undefined
  let changes: (() => void) | undefined
  let current: CloudTodoWorkspaceObservation | undefined
  const mutations = createCloudTodoBoardMutations(state, () => current)
  return {
    ...state,
    subscribeState: state.subscribe,
    ...mutations,
    resetBoardSnapshot: board.resetSnapshot,
    advanceTaskPanelSession: navigation.advanceTaskPanelSession,
    nextQuickAddId: navigation.nextQuickAddId,
    rememberProjectRequest: navigation.rememberProjectRequest,
    resetProjectView: navigation.reset,
    continueChangeRequestRepair: repair.repair,
    isObserved: () => observers.size > 0,
    isCurrentBoard(project: LocatedCloudProject | null, parentId: string | null) {
      const active = current?.project
      return Boolean(
        observers.size &&
        current &&
        project &&
        active &&
        sameProjectSpace(projectSpaceRef(active), projectSpaceRef(project)) &&
        active.access_role === project.access_role &&
        active.current_user_id === project.current_user_id &&
        state.getSnapshot().boardParentId === parentId
      )
    },
    subscribe(input: CloudTodoWorkspaceObservation, listener: () => void) {
      if (
        input.props.user.id !== owner.userId ||
        input.cloudApi !== owner.cloudApi ||
        input.localApi !== (owner.catalogApi ?? owner.localApi)
      )
        return () => undefined
      current = input
      observers.add(listener)
      const unsubscribe = state.subscribe(listener)
      queueMicrotask(() => {
        if (current !== input || !observers.size) return
        if (!changes) changes = board.startChanges()
        const snapshot = state.getSnapshot()
        const beforeNavigation = state.getSnapshot()
        navigation.observe(input)
        if (state.getSnapshot() !== beforeNavigation) return
        resources.observe(input)
        board.observe({
          project: input.project,
          api: input.projectApi,
          agents: input.projectAgents,
          chat: input.projectChat,
          aitable: input.props.services.aitableApi,
          dws: input.props.services.dwsApi,
          parentId: snapshot.boardParentId,
          runtimeSignature: input.runtimeSignature,
          refreshRequest: snapshot.boardRefreshNonce,
        })
        repair.observe(input)
        const request = input.backgroundTask
        if (request && request.key !== admittedBackgroundRequest) {
          admittedBackgroundRequest = request.key
          void startBackgroundTask(request.props, request.workbench).catch(cause =>
            request.props.onError(cause instanceof Error ? cause.message : String(cause))
          )
        }
      })
      return () => {
        unsubscribe()
        observers.delete(listener)
        queueMicrotask(() => {
          if (observers.size) return
          current = undefined
          changes?.()
          changes = undefined
          board.stop()
          resources.stop()
          navigation.stop()
          repair.stop()
        })
      }
    },
  }
}
