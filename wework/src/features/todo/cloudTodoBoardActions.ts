import type { LocatedLoopItem } from './cloudTodoWorkspaceTypes'
import { externalBoardColumnPageSize, toWeworkCloudProject } from './cloudTodoWorkspaceSupport'
import type { ProjectBoardDrop } from '@wegent/collaboration/project-board/projectBoardDnd'
import { track } from '@/telemetry/client'
import type { CloudTodoWorkspaceData } from './useCloudTodoWorkspaceData'
export function createCloudTodoBoardActions(data: CloudTodoWorkspaceData) {
  const {
    t,
    baseBoardStatusGrouping,
    workspaceSource,
    cloudWorkspaceApi,
    cloudWorkspaceMessages,
    cloudWorkspace,
    projectSpaceApis,
    selectedProjectId,
    replaceProject,
    selectedProject,
    selectedProjectKey,
    personalGroupKey,
    projectForItem,
    locateItems,
    apiForProject,
    selectedProjectApi,
    isExternalGitBoard,
    nativeStatuses,
    processingStartStatusId,
    standardBoardController,
    setActiveDragItemId,
    nativeGroupBy,
    updateStandardBoardItem,
    setSelectedItem,
    boardParentId,
    setItems,
    setLocalItemTaskBindings,
    setItemTaskBindingsProjectKey,
    localExternalPageCursors,
    setLocalExternalPageCursors,
    localExternalPageLoading,
    setLocalExternalPageLoading,
    groupScopeBusy,
    setGroupScopeBusy,
    setBoardError,
    batchConfirmBusy,
    setBatchConfirmBusy,
    setBatchConfirmError,
    setBatchConfirmItems,
    batchConfirmRetryItemKeys,
    setBatchConfirmRetryItemKeys,
  } = data
  async function loadMoreExternalColumn(itemStatus: string): Promise<void> {
    if (selectedProject?.location === 'cloud') {
      await cloudWorkspace.commands.loadMoreExternalColumn(itemStatus)
      return
    }
    const cursor = localExternalPageCursors[itemStatus]
    if (
      !isExternalGitBoard ||
      !selectedProject ||
      !selectedProjectId ||
      !selectedProjectKey ||
      !selectedProjectApi ||
      !cursor ||
      localExternalPageLoading[itemStatus]
    ) {
      return
    }
    setLocalExternalPageLoading(current => ({ ...current, [itemStatus]: true }))
    try {
      const page = await selectedProjectApi.listLoopItemsPage(selectedProjectId, {
        status: itemStatus,
        parentId: boardParentId,
        cursor,
        limit: externalBoardColumnPageSize,
      })
      if (!workspaceSource.isCurrentBoard(selectedProject, boardParentId)) return
      const locatedItems = locateItems(page.items, selectedProject.project_store)
      setItems(current => {
        return Array.from(
          new Map([...current, ...locatedItems].map(item => [item.id, item])).values()
        )
      })
      setLocalExternalPageCursors(current => ({
        ...current,
        [itemStatus]: page.next_cursor,
      }))
      setLocalItemTaskBindings(current => {
        const next = { ...current }
        for (const binding of page.task_bindings) {
          if (!binding.loop_item_id) continue
          next[binding.loop_item_id] = [
            ...(next[binding.loop_item_id] ?? []).filter(candidate => candidate.id !== binding.id),
            binding,
          ]
        }
        return next
      })
      setItemTaskBindingsProjectKey(selectedProjectKey)
    } catch (error) {
      if (!workspaceSource.isCurrentBoard(selectedProject, boardParentId)) return
      setBoardError(error instanceof Error ? error.message : t('todo.load_more_issues_failed'))
    } finally {
      if (workspaceSource.isCurrentBoard(selectedProject, boardParentId))
        setLocalExternalPageLoading(current => ({ ...current, [itemStatus]: false }))
    }
  }
  async function confirmReviewItems(reviewItems: LocatedLoopItem[]) {
    if (batchConfirmBusy || reviewItems.length === 0) return
    setBatchConfirmBusy(true)
    setBatchConfirmError(null)
    const failedItems: LocatedLoopItem[] = []
    const updatedItems = new Map<string, LocatedLoopItem>()
    try {
      const results = await Promise.allSettled(
        reviewItems.map(async item => {
          const itemKey = `${item.project_store ?? 'backend'}:${item.id}`
          const project = projectForItem(item)
          const api = apiForProject(project)
          const target =
            batchConfirmRetryItemKeys.has(itemKey) && project?.location === 'local' && api
              ? {
                  ...(await api.getLoopItem(item.id)),
                  project_store: item.project_store,
                }
              : item
          return updateStandardBoardItem(target, { status: 'completed' }).then(updated => ({
            ...updated,
            project_store: item.project_store,
          }))
        })
      )
      results.forEach((result, index) => {
        const source = reviewItems[index]
        if (result.status === 'fulfilled') {
          updatedItems.set(`${source.project_store ?? 'backend'}:${source.id}`, result.value)
          return
        }
        failedItems.push(source)
        console.error('[Wework project board] batch confirmation failed', {
          itemId: source.id,
          error: result.reason,
        })
      })
      if (updatedItems.size > 0) {
        setItems(current =>
          current.map(candidate => {
            const updated = updatedItems.get(
              `${candidate.project_store ?? 'backend'}:${candidate.id}`
            )
            return updated ?? candidate
          })
        )
        setSelectedItem(current => {
          if (!current) return current
          return updatedItems.get(`${current.project_store ?? 'backend'}:${current.id}`) ?? current
        })
        track('feature_action_completed', {
          domain: 'board_item',
          action: 'update',
        })
      }
      setBatchConfirmItems(failedItems.length > 0 ? failedItems : null)
      setBatchConfirmRetryItemKeys(
        new Set(
          failedItems.flatMap(item =>
            projectForItem(item)?.location === 'local'
              ? [`${item.project_store ?? 'backend'}:${item.id}`]
              : []
          )
        )
      )
      if (failedItems.length > 0) {
        setBatchConfirmError(
          t('todo.batch_confirm_failed', '{{count}} 个事项确认失败，请稍后重试', {
            count: failedItems.length,
          })
        )
      }
    } finally {
      setBatchConfirmBusy(false)
    }
  }
  function finishBoardDrop(drop: ProjectBoardDrop) {
    setActiveDragItemId(null)
    standardBoardController.moveDroppedItem(drop)
  }
  async function saveGlobalGroupBy() {
    if (baseBoardStatusGrouping) return
    if (!selectedProject || groupScopeBusy) return
    const projectApi = projectSpaceApis[selectedProject.location]
    if (selectedProject.location === 'cloud' ? !cloudWorkspaceApi : !projectApi) return
    setGroupScopeBusy(true)
    setBoardError(null)
    try {
      const boardConfig = {
        ...selectedProject.board_config,
        group_by: nativeGroupBy,
        processing_start_status_id: processingStartStatusId,
        statuses: nativeStatuses,
      }
      const updated =
        selectedProject.location === 'cloud'
          ? await cloudWorkspace.commands
              .updateProject(String(selectedProject.id), {
                version: selectedProject.version,
                boardConfig,
              })
              .then(updated => {
                if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
                return toWeworkCloudProject(updated)
              })
          : await projectApi!.updateCloudProject(selectedProject.id, {
              version: selectedProject.version,
              board_config: boardConfig,
            })
      if (personalGroupKey) localStorage.removeItem(personalGroupKey)
      replaceProject(selectedProject, updated)
      track('feature_action_completed', { domain: 'project_space', action: 'save_grouping' })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setBoardError(cause instanceof Error ? cause.message : '保存全局分组失败')
    } finally {
      setGroupScopeBusy(false)
    }
  }
  return { loadMoreExternalColumn, confirmReviewItems, finishBoardDrop, saveGlobalGroupBy }
}
