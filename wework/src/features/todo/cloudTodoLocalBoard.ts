import type { CloudLoopItem } from '@/api/deliveries'
import type { WorkbenchServices, DeliveryApi } from '@/features/workbench/workbenchServices'
import type { RuntimeProjectSpaceRef } from '@/types/api'
import type {
  BoardReadResult,
  LocatedCloudProject,
  LocatedLoopItem,
  LoopItemTaskBinding,
} from './cloudTodoWorkspaceTypes'
import type { createCloudTodoWorkspaceState } from './cloudTodoWorkspaceState'
import {
  sameProjectSpace,
  projectSpaceRef,
  projectSpaceKey,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
} from './projectSpaceSelection'
const statuses = ['inbox', 'pending', 'in_progress', 'in_review', 'completed'] as const
export function locateBoardItems<T extends CloudLoopItem>(
  items: T[],
  projectStore: RuntimeProjectSpaceRef['projectStore']
) {
  return items.map(item => ({ ...item, project_store: projectStore }))
}
export function cloudTodoBoardSignature(
  projectKey: string,
  items: CloudLoopItem[],
  error: string | null,
  context?: unknown
) {
  return `${projectKey}\0${error ?? ''}\0${JSON.stringify([items, context ?? null])}`
}
export interface CloudTodoBoardObservation {
  project: LocatedCloudProject | null
  api: DeliveryApi | undefined
  agents: WorkbenchServices['projectChatAgentApi']
  chat: WorkbenchServices['projectChatClient']
  aitable: WorkbenchServices['aitableApi']
  dws: WorkbenchServices['dwsApi']
  parentId: string | null
  runtimeSignature: string
  refreshRequest: number
}
export function createCloudTodoLocalBoard(state: ReturnType<typeof createCloudTodoWorkspaceState>) {
  let current: CloudTodoBoardObservation | undefined
  let generation = 0
  let request = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let signature: string | null = null
  let releaseLive: (() => void) | undefined
  let liveGeneration = 0
  let live = false
  const failedByItem = new Map<string, boolean>()
  const apply = (key: string, items: LocatedLoopItem[], error: string | null) => {
    let newlyFailed: LocatedLoopItem | undefined
    for (const item of items) {
      const identity = `${key}:${item.id}`
      const failed = item.execution_state === 'failed'
      if (failedByItem.get(identity) === false && failed && item.can_view_detail !== false)
        newlyFailed = item
      failedByItem.set(identity, failed)
    }
    state.setItems(previous => {
      const byId = new Map(previous.map(item => [item.id, item]))
      return items.map(incoming => {
        const existing = byId.get(incoming.id)
        return existing &&
          existing.cloud_project_id === incoming.cloud_project_id &&
          existing.project_store === incoming.project_store &&
          existing.version > incoming.version
          ? existing
          : incoming
      })
    })
    state.update({
      itemsProjectKey: key,
      boardError: error,
      ...(newlyFailed
        ? {
            backgroundTaskItemId: null,
            selectedTaskBinding: null,
            taskComposerRequest: null,
            selectedItem: newlyFailed,
          }
        : {}),
    })
  }
  const read = async () => {
    const input = current
    const project = input?.project
    const api = input?.api
    if (!input || !project || project.location !== 'local' || !api) return
    const epoch = generation
    const revision = ++request
    const valid = () => epoch === generation && revision === request
    const key = projectSpaceKey(projectSpaceRef(project))
    const external = project.task_provider === 'github' || project.task_provider === 'gitlab'
    const snapshotKey = external ? `${key}:${input.parentId ?? 'root'}` : key
    try {
      if (project.task_provider === 'dingtalk_aitable' && input.aitable)
        await input.aitable.configureProject(project)
      if (!valid()) return
      let result: BoardReadResult
      if (external) {
        const [pages, members, agents] = await Promise.all([
          Promise.all(
            statuses.map(status =>
              api.listLoopItemsPage(project.id, { status, parentId: input.parentId, limit: 10 })
            )
          ),
          api.listCloudProjectMembers(project.id),
          input.agents?.list(project.id) ?? Promise.resolve([]),
        ])
        result = {
          items: locateBoardItems(
            pages.flatMap(page => page.items),
            project.project_store
          ),
          task_bindings: pages.flatMap(page => page.task_bindings),
          members,
          agents,
          page_cursors: Object.fromEntries(
            pages.map((page, index) => [statuses[index], page.next_cursor])
          ),
        }
      } else {
        const [snapshot, agents] = await Promise.all([
          api.getBoardSnapshot(project.id),
          input.agents?.list(project.id),
        ])
        result = {
          ...snapshot,
          items: locateBoardItems(snapshot.items, project.project_store),
          agents: agents ?? snapshot.agents,
        }
      }
      if (!valid()) return
      state.setDingtalkAuthPrompt(false)
      const context = result.task_bindings
        ? {
            taskBindings: result.task_bindings,
            members: result.members ?? [],
            agents: result.agents ?? [],
          }
        : undefined
      const nextSignature = cloudTodoBoardSignature(snapshotKey, result.items, null, context)
      if (signature === nextSignature) return
      signature = nextSignature
      const items = result.items as LocatedLoopItem[]
      if (external) {
        state.setItems(previous => [
          ...previous.filter(
            item =>
              String(item.cloud_project_id) === String(project.id) &&
              item.project_store === project.project_store &&
              item.parent_id !== input.parentId
          ),
          ...items,
        ])
        state.update({
          itemsProjectKey: key,
          boardError: null,
          localExternalPageCursors: result.page_cursors ?? {},
        })
      } else {
        apply(key, items, null)
        state.setLocalExternalPageCursors({})
      }
      if (context) {
        const bindings: Record<string, LoopItemTaskBinding[]> = {}
        for (const binding of context.taskBindings)
          if (binding.loop_item_id) (bindings[binding.loop_item_id] ??= []).push(binding)
        state.setLocalItemTaskBindings(previous =>
          external ? { ...previous, ...bindings } : bindings
        )
        state.setItemTaskBindingsProjectKey(key)
        state.setLocalProjectMembers(previous => ({ ...previous, [key]: context.members }))
        state.setLocalProjectAgents(previous => ({
          ...previous,
          [key]: context.agents.filter(agent => agent.status === 'active'),
        }))
      }
      state.setLocalProjectItems(previous => ({
        ...previous,
        [key]: external
          ? Array.from(
              new Map([...(previous[key] ?? []), ...items].map(item => [item.id, item])).values()
            )
          : items,
      }))
      state.setLocalProjectCounts(previous => ({ ...previous, [key]: result.items.length }))
      state.setSelectedItem(previous =>
        previous &&
        sameProjectSpace(
          {
            projectStore: previous.project_store ?? project.project_store,
            projectId: previous.cloud_project_id,
          },
          projectSpaceRef(project)
        )
          ? (items.find(item => item.id === previous.id) ?? (external ? previous : null))
          : previous
      )
    } catch (error) {
      console.error('[Wework project board] issue refresh failed', { projectId: project.id, error })
      if (!valid()) return
      if (project.task_provider === 'dingtalk_aitable' && input.dws) {
        try {
          const status = await input.dws.authStatus()
          if (!valid()) return
          if (!status.authenticated || status.token_valid === false) {
            state.setDingtalkAuthPrompt(true)
            apply(key, [], null)
            return
          }
        } catch {
          /* Preserve the original board error when authentication lookup fails. */
        }
      }
      if (!valid()) return
      state.setDingtalkAuthPrompt(false)
      const message = error instanceof Error ? error.message : '任务加载失败'
      const nextSignature = cloudTodoBoardSignature(snapshotKey, [], message)
      if (signature === nextSignature) return
      signature = nextSignature
      apply(key, [], message)
      state.update({
        localExternalPageCursors: {},
        localItemTaskBindings: {},
        itemTaskBindingsProjectKey: key,
      })
      state.setLocalProjectMembers(previous => ({ ...previous, [key]: [] }))
      state.setLocalProjectAgents(previous => ({ ...previous, [key]: [] }))
    }
  }
  const stopLive = () => {
    liveGeneration++
    live = false
    releaseLive?.()
    releaseLive = undefined
  }
  const connectLive = (input: CloudTodoBoardObservation) => {
    stopLive()
    if (!input.chat?.subscribeLoopItemChanges || !input.project) return
    const epoch = liveGeneration
    const projectId = String(input.project.id)
    void input.chat
      .subscribeLoopItemChanges(event => {
        if (epoch === liveGeneration && event.projectId === projectId)
          state.setBoardRefreshNonce(value => value + 1)
      })
      .then(release => {
        if (epoch !== liveGeneration) release()
        else {
          releaseLive = release
          live = true
        }
      })
      .catch(error => {
        if (epoch !== liveGeneration) return
        live = false
        console.warn('[Wework project board] issue-change subscription failed', error)
      })
  }
  return {
    resetSnapshot() {
      signature = null
    },
    observe(input: CloudTodoBoardObservation) {
      const previous = current
      current = input
      if (
        !previous ||
        previous.chat !== input.chat ||
        previous.project?.id !== input.project?.id ||
        previous.project?.project_store !== input.project?.project_store
      )
        connectLive(input)
      const changed =
        !previous ||
        Object.keys(input).some(
          key =>
            input[key as keyof CloudTodoBoardObservation] !==
            previous[key as keyof CloudTodoBoardObservation]
        )
      if (!changed) return
      if (
        previous?.parentId !== input.parentId ||
        previous?.project?.id !== input.project?.id ||
        previous?.project?.project_store !== input.project?.project_store ||
        previous?.project?.access_role !== input.project?.access_role ||
        previous?.project?.current_user_id !== input.project?.current_user_id
      )
        state.setLocalExternalPageLoading({})
      generation++
      clearInterval(timer)
      timer = undefined
      if (input.project?.location === 'local' && input.api) {
        void read()
        timer = setInterval(() => {
          if (document.visibilityState === 'visible' && !live) void read()
        }, 15000)
      }
    },
    startChanges() {
      const refresh = ({ project }: { project: RuntimeProjectSpaceRef }) => {
        if (sameProjectSpace(project, current?.project ? projectSpaceRef(current.project) : null))
          state.setBoardRefreshNonce(value => value + 1)
      }
      const releases = [
        subscribeProjectSpaceTaskBindingChanged(refresh),
        subscribeProjectSpaceTaskContextChanged(refresh),
      ]
      return () => releases.forEach(release => release())
    },
    stop() {
      generation++
      request++
      clearInterval(timer)
      timer = undefined
      stopLive()
      current = undefined
    },
  }
}
