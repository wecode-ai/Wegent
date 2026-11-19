import type { SetStateAction } from 'react'
import type { CloudLoopItem, CloudLoopItemAttachment, CloudProjectMember } from '@/api/deliveries'
import type { AITableField } from '@/api/aitable'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProjectSpaceRef } from '@/types/api'
import type { AutomationSelectionCandidate } from './AutomationSelectionDialog'
import { emptyTaskSearchFilters, type TaskSearchFilters } from './taskSearch'
import type {
  ProjectView,
  LocatedCloudProject,
  LocatedLoopItem,
  LoopItemTaskBinding,
  SelectedTaskBinding,
  TaskComposerRequest,
  AssigneeQuickAddRequest,
} from './cloudTodoWorkspaceTypes'
export function initialCloudTodoWorkspaceState(hasLocal: boolean) {
  return {
    internalSelectedProjectRef: null as RuntimeProjectSpaceRef | null,
    projectView: 'board' as ProjectView,
    projectSettingsSectionId: 'project',
    assigneeQuickAddRequest: null as AssigneeQuickAddRequest | null,
    boardSettingsOpen: false,
    selectedItem: null as LocatedLoopItem | null,
    boardParentId: null as string | null,
    localProjectSpaces: [] as LocatedCloudProject[],
    localProjectCounts: {} as Record<string, number>,
    localProjectMembers: {} as Record<string, CloudProjectMember[]>,
    localProjectAgents: {} as Record<string, ProjectChatAgent[]>,
    localProjectItems: {} as Record<string, CloudLoopItem[]>,
    items: [] as LocatedLoopItem[],
    localItemTaskBindings: {} as Record<string, LoopItemTaskBinding[]>,
    itemTaskBindingsProjectKey: null as string | null,
    itemsProjectKey: null as string | null,
    localExternalPageCursors: {} as Record<string, string | null>,
    localExternalPageLoading: {} as Record<string, boolean>,
    backgroundTaskItemId: null as string | null,
    detailItems: [] as LocatedLoopItem[],
    createProjectOpen: false,
    createTodoOpen: false,
    createTodoParent: null as LocatedLoopItem | null,
    createTodoStatus: 'inbox' as CloudLoopItem['status'],
    createTodoInitialTitle: undefined as string | undefined,
    createTodoNonce: 0,
    createTodoStartRuntime: false,
    createTodoContinueCreating: false,
    issueComposerOpen: false,
    issueComposerBoardKey: '',
    issueComposerStatus: 'inbox' as CloudLoopItem['status'],
    issueComposerInitialContent: '',
    issueComposerPresentation: 'page' as 'page' | 'popup',
    issueComposerBusy: false,
    issueComposerError: null as string | null,
    pendingAutomationSelection: null as {
      candidates: AutomationSelectionCandidate[]
      onCancel: () => void
      onConfirm: (automationId: string) => Promise<void>
    } | null,
    projectAssistantOpen: false,
    selectedTaskBinding: null as SelectedTaskBinding | null,
    taskComposerRequest: null as TaskComposerRequest | null,
    taskPanelSessionId: 0,
    aitableFields: [] as AITableField[],
    aitableGroupFieldId: '',
    localProjectFilter: 'all',
    groupScopeBusy: false,
    globalSearchOpen: false,
    globalSearchQuery: '',
    projectSearchOpen: false,
    projectSearchQuery: '',
    projectSearchFilters: emptyTaskSearchFilters as TaskSearchFilters,
    localProjectsLoading: hasLocal,
    localProjectsError: null as string | null,
    localProjectsRefreshNonce: 0,
    boardError: null as string | null,
    taskDispatchError: null as string | null,
    dingtalkAuthPrompt: false,
    dingtalkAuthBusy: false,
    boardRefreshNonce: 0,
    sidebarCollapsed: false,
    renameProject: null as LocatedCloudProject | null,
    renameProjectName: '',
    renameBusy: false,
    renameError: null as string | null,
    archiveProject: null as LocatedCloudProject | null,
    archiveItem: null as CloudLoopItem | null,
    archiveBusy: false,
    archiveError: null as string | null,
    batchConfirmBusy: false,
    batchConfirmError: null as string | null,
    batchConfirmItems: null as LocatedLoopItem[] | null,
    batchConfirmRetryItemKeys: new Set() as ReadonlySet<string>,
    runtimeBatchArchiveItems: null as LocatedLoopItem[] | null,
    batchArchiveError: null as string | null,
    issueResourceAttachmentState: { owner: null, itemId: null, attachments: [] } as {
      owner: string | null
      itemId: string | null
      attachments: CloudLoopItemAttachment[]
    },
  }
}
export type CloudTodoWorkspaceState = ReturnType<typeof initialCloudTodoWorkspaceState>
export function createCloudTodoWorkspaceState(hasLocal: boolean) {
  let snapshot = initialCloudTodoWorkspaceState(hasLocal)
  const listeners = new Set<() => void>()
  const update = (patch: Partial<CloudTodoWorkspaceState>) => {
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(snapshot[key as keyof CloudTodoWorkspaceState], value)
      )
    )
      return
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const resolve = <T>(value: SetStateAction<T>, current: T): T =>
    typeof value === 'function' ? (value as (current: T) => T)(current) : value
  return {
    getSnapshot: () => snapshot,
    update,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setSelectedProjectRef(
      value: SetStateAction<CloudTodoWorkspaceState['internalSelectedProjectRef']>
    ) {
      update({ internalSelectedProjectRef: resolve(value, snapshot.internalSelectedProjectRef) })
    },
    setProjectView(value: SetStateAction<CloudTodoWorkspaceState['projectView']>) {
      update({ projectView: resolve(value, snapshot.projectView) })
    },
    setProjectSettingsSectionId(
      value: SetStateAction<CloudTodoWorkspaceState['projectSettingsSectionId']>
    ) {
      update({ projectSettingsSectionId: resolve(value, snapshot.projectSettingsSectionId) })
    },
    setAssigneeQuickAddRequest(
      value: SetStateAction<CloudTodoWorkspaceState['assigneeQuickAddRequest']>
    ) {
      update({ assigneeQuickAddRequest: resolve(value, snapshot.assigneeQuickAddRequest) })
    },
    setBoardSettingsOpen(value: SetStateAction<CloudTodoWorkspaceState['boardSettingsOpen']>) {
      update({ boardSettingsOpen: resolve(value, snapshot.boardSettingsOpen) })
    },
    setSelectedItem(value: SetStateAction<CloudTodoWorkspaceState['selectedItem']>) {
      update({ selectedItem: resolve(value, snapshot.selectedItem) })
    },
    setBoardParentId(value: SetStateAction<CloudTodoWorkspaceState['boardParentId']>) {
      update({ boardParentId: resolve(value, snapshot.boardParentId) })
    },
    setLocalProjectSpaces(value: SetStateAction<CloudTodoWorkspaceState['localProjectSpaces']>) {
      update({ localProjectSpaces: resolve(value, snapshot.localProjectSpaces) })
    },
    setLocalProjectCounts(value: SetStateAction<CloudTodoWorkspaceState['localProjectCounts']>) {
      update({ localProjectCounts: resolve(value, snapshot.localProjectCounts) })
    },
    setLocalProjectMembers(value: SetStateAction<CloudTodoWorkspaceState['localProjectMembers']>) {
      update({ localProjectMembers: resolve(value, snapshot.localProjectMembers) })
    },
    setLocalProjectAgents(value: SetStateAction<CloudTodoWorkspaceState['localProjectAgents']>) {
      update({ localProjectAgents: resolve(value, snapshot.localProjectAgents) })
    },
    setLocalProjectItems(value: SetStateAction<CloudTodoWorkspaceState['localProjectItems']>) {
      update({ localProjectItems: resolve(value, snapshot.localProjectItems) })
    },
    setItems(value: SetStateAction<CloudTodoWorkspaceState['items']>) {
      update({ items: resolve(value, snapshot.items) })
    },
    setLocalItemTaskBindings(
      value: SetStateAction<CloudTodoWorkspaceState['localItemTaskBindings']>
    ) {
      update({ localItemTaskBindings: resolve(value, snapshot.localItemTaskBindings) })
    },
    setItemTaskBindingsProjectKey(
      value: SetStateAction<CloudTodoWorkspaceState['itemTaskBindingsProjectKey']>
    ) {
      update({ itemTaskBindingsProjectKey: resolve(value, snapshot.itemTaskBindingsProjectKey) })
    },
    setItemsProjectKey(value: SetStateAction<CloudTodoWorkspaceState['itemsProjectKey']>) {
      update({ itemsProjectKey: resolve(value, snapshot.itemsProjectKey) })
    },
    setLocalExternalPageCursors(
      value: SetStateAction<CloudTodoWorkspaceState['localExternalPageCursors']>
    ) {
      update({ localExternalPageCursors: resolve(value, snapshot.localExternalPageCursors) })
    },
    setLocalExternalPageLoading(
      value: SetStateAction<CloudTodoWorkspaceState['localExternalPageLoading']>
    ) {
      update({ localExternalPageLoading: resolve(value, snapshot.localExternalPageLoading) })
    },
    setBackgroundTaskItemId(
      value: SetStateAction<CloudTodoWorkspaceState['backgroundTaskItemId']>
    ) {
      update({ backgroundTaskItemId: resolve(value, snapshot.backgroundTaskItemId) })
    },
    setDetailItems(value: SetStateAction<CloudTodoWorkspaceState['detailItems']>) {
      update({ detailItems: resolve(value, snapshot.detailItems) })
    },
    setCreateProjectOpen(value: SetStateAction<CloudTodoWorkspaceState['createProjectOpen']>) {
      update({ createProjectOpen: resolve(value, snapshot.createProjectOpen) })
    },
    setCreateTodoOpen(value: SetStateAction<CloudTodoWorkspaceState['createTodoOpen']>) {
      update({ createTodoOpen: resolve(value, snapshot.createTodoOpen) })
    },
    setCreateTodoParent(value: SetStateAction<CloudTodoWorkspaceState['createTodoParent']>) {
      update({ createTodoParent: resolve(value, snapshot.createTodoParent) })
    },
    setCreateTodoStatus(value: SetStateAction<CloudTodoWorkspaceState['createTodoStatus']>) {
      update({ createTodoStatus: resolve(value, snapshot.createTodoStatus) })
    },
    setCreateTodoInitialTitle(
      value: SetStateAction<CloudTodoWorkspaceState['createTodoInitialTitle']>
    ) {
      update({ createTodoInitialTitle: resolve(value, snapshot.createTodoInitialTitle) })
    },
    setCreateTodoNonce(value: SetStateAction<CloudTodoWorkspaceState['createTodoNonce']>) {
      update({ createTodoNonce: resolve(value, snapshot.createTodoNonce) })
    },
    setCreateTodoStartRuntime(
      value: SetStateAction<CloudTodoWorkspaceState['createTodoStartRuntime']>
    ) {
      update({ createTodoStartRuntime: resolve(value, snapshot.createTodoStartRuntime) })
    },
    setCreateTodoContinueCreating(
      value: SetStateAction<CloudTodoWorkspaceState['createTodoContinueCreating']>
    ) {
      update({ createTodoContinueCreating: resolve(value, snapshot.createTodoContinueCreating) })
    },
    setIssueComposerOpen(value: SetStateAction<CloudTodoWorkspaceState['issueComposerOpen']>) {
      update({ issueComposerOpen: resolve(value, snapshot.issueComposerOpen) })
    },
    setIssueComposerBoardKey(
      value: SetStateAction<CloudTodoWorkspaceState['issueComposerBoardKey']>
    ) {
      update({ issueComposerBoardKey: resolve(value, snapshot.issueComposerBoardKey) })
    },
    setIssueComposerStatus(value: SetStateAction<CloudTodoWorkspaceState['issueComposerStatus']>) {
      update({ issueComposerStatus: resolve(value, snapshot.issueComposerStatus) })
    },
    setIssueComposerInitialContent(
      value: SetStateAction<CloudTodoWorkspaceState['issueComposerInitialContent']>
    ) {
      update({ issueComposerInitialContent: resolve(value, snapshot.issueComposerInitialContent) })
    },
    setIssueComposerPresentation(
      value: SetStateAction<CloudTodoWorkspaceState['issueComposerPresentation']>
    ) {
      update({ issueComposerPresentation: resolve(value, snapshot.issueComposerPresentation) })
    },
    setIssueComposerBusy(value: SetStateAction<CloudTodoWorkspaceState['issueComposerBusy']>) {
      update({ issueComposerBusy: resolve(value, snapshot.issueComposerBusy) })
    },
    setIssueComposerError(value: SetStateAction<CloudTodoWorkspaceState['issueComposerError']>) {
      update({ issueComposerError: resolve(value, snapshot.issueComposerError) })
    },
    setPendingAutomationSelection(
      value: SetStateAction<CloudTodoWorkspaceState['pendingAutomationSelection']>
    ) {
      update({ pendingAutomationSelection: resolve(value, snapshot.pendingAutomationSelection) })
    },
    setProjectAssistantOpen(
      value: SetStateAction<CloudTodoWorkspaceState['projectAssistantOpen']>
    ) {
      update({ projectAssistantOpen: resolve(value, snapshot.projectAssistantOpen) })
    },
    setSelectedTaskBinding(value: SetStateAction<CloudTodoWorkspaceState['selectedTaskBinding']>) {
      update({ selectedTaskBinding: resolve(value, snapshot.selectedTaskBinding) })
    },
    setTaskComposerRequest(value: SetStateAction<CloudTodoWorkspaceState['taskComposerRequest']>) {
      update({ taskComposerRequest: resolve(value, snapshot.taskComposerRequest) })
    },
    setTaskPanelSessionId(value: SetStateAction<CloudTodoWorkspaceState['taskPanelSessionId']>) {
      update({ taskPanelSessionId: resolve(value, snapshot.taskPanelSessionId) })
    },
    setAitableFields(value: SetStateAction<CloudTodoWorkspaceState['aitableFields']>) {
      update({ aitableFields: resolve(value, snapshot.aitableFields) })
    },
    setAitableGroupFieldId(value: SetStateAction<CloudTodoWorkspaceState['aitableGroupFieldId']>) {
      update({ aitableGroupFieldId: resolve(value, snapshot.aitableGroupFieldId) })
    },
    setLocalProjectFilter(value: SetStateAction<CloudTodoWorkspaceState['localProjectFilter']>) {
      update({ localProjectFilter: resolve(value, snapshot.localProjectFilter) })
    },
    setGroupScopeBusy(value: SetStateAction<CloudTodoWorkspaceState['groupScopeBusy']>) {
      update({ groupScopeBusy: resolve(value, snapshot.groupScopeBusy) })
    },
    setGlobalSearchOpen(value: SetStateAction<CloudTodoWorkspaceState['globalSearchOpen']>) {
      update({ globalSearchOpen: resolve(value, snapshot.globalSearchOpen) })
    },
    setGlobalSearchQuery(value: SetStateAction<CloudTodoWorkspaceState['globalSearchQuery']>) {
      update({ globalSearchQuery: resolve(value, snapshot.globalSearchQuery) })
    },
    setProjectSearchOpen(value: SetStateAction<CloudTodoWorkspaceState['projectSearchOpen']>) {
      update({ projectSearchOpen: resolve(value, snapshot.projectSearchOpen) })
    },
    setProjectSearchQuery(value: SetStateAction<CloudTodoWorkspaceState['projectSearchQuery']>) {
      update({ projectSearchQuery: resolve(value, snapshot.projectSearchQuery) })
    },
    setProjectSearchFilters(
      value: SetStateAction<CloudTodoWorkspaceState['projectSearchFilters']>
    ) {
      update({ projectSearchFilters: resolve(value, snapshot.projectSearchFilters) })
    },
    setLocalProjectsLoading(
      value: SetStateAction<CloudTodoWorkspaceState['localProjectsLoading']>
    ) {
      update({ localProjectsLoading: resolve(value, snapshot.localProjectsLoading) })
    },
    setLocalProjectsError(value: SetStateAction<CloudTodoWorkspaceState['localProjectsError']>) {
      update({ localProjectsError: resolve(value, snapshot.localProjectsError) })
    },
    setLocalProjectsRefreshNonce(
      value: SetStateAction<CloudTodoWorkspaceState['localProjectsRefreshNonce']>
    ) {
      update({ localProjectsRefreshNonce: resolve(value, snapshot.localProjectsRefreshNonce) })
    },
    setBoardError(value: SetStateAction<CloudTodoWorkspaceState['boardError']>) {
      update({ boardError: resolve(value, snapshot.boardError) })
    },
    setTaskDispatchError(value: SetStateAction<CloudTodoWorkspaceState['taskDispatchError']>) {
      update({ taskDispatchError: resolve(value, snapshot.taskDispatchError) })
    },
    setDingtalkAuthPrompt(value: SetStateAction<CloudTodoWorkspaceState['dingtalkAuthPrompt']>) {
      update({ dingtalkAuthPrompt: resolve(value, snapshot.dingtalkAuthPrompt) })
    },
    setDingtalkAuthBusy(value: SetStateAction<CloudTodoWorkspaceState['dingtalkAuthBusy']>) {
      update({ dingtalkAuthBusy: resolve(value, snapshot.dingtalkAuthBusy) })
    },
    setBoardRefreshNonce(value: SetStateAction<CloudTodoWorkspaceState['boardRefreshNonce']>) {
      update({ boardRefreshNonce: resolve(value, snapshot.boardRefreshNonce) })
    },
    setSidebarCollapsed(value: SetStateAction<CloudTodoWorkspaceState['sidebarCollapsed']>) {
      update({ sidebarCollapsed: resolve(value, snapshot.sidebarCollapsed) })
    },
    setRenameProject(value: SetStateAction<CloudTodoWorkspaceState['renameProject']>) {
      update({ renameProject: resolve(value, snapshot.renameProject) })
    },
    setRenameProjectName(value: SetStateAction<CloudTodoWorkspaceState['renameProjectName']>) {
      update({ renameProjectName: resolve(value, snapshot.renameProjectName) })
    },
    setRenameBusy(value: SetStateAction<CloudTodoWorkspaceState['renameBusy']>) {
      update({ renameBusy: resolve(value, snapshot.renameBusy) })
    },
    setRenameError(value: SetStateAction<CloudTodoWorkspaceState['renameError']>) {
      update({ renameError: resolve(value, snapshot.renameError) })
    },
    setArchiveProject(value: SetStateAction<CloudTodoWorkspaceState['archiveProject']>) {
      update({ archiveProject: resolve(value, snapshot.archiveProject) })
    },
    setArchiveItem(value: SetStateAction<CloudTodoWorkspaceState['archiveItem']>) {
      update({ archiveItem: resolve(value, snapshot.archiveItem) })
    },
    setArchiveBusy(value: SetStateAction<CloudTodoWorkspaceState['archiveBusy']>) {
      update({ archiveBusy: resolve(value, snapshot.archiveBusy) })
    },
    setArchiveError(value: SetStateAction<CloudTodoWorkspaceState['archiveError']>) {
      update({ archiveError: resolve(value, snapshot.archiveError) })
    },
    setBatchConfirmBusy(value: SetStateAction<CloudTodoWorkspaceState['batchConfirmBusy']>) {
      update({ batchConfirmBusy: resolve(value, snapshot.batchConfirmBusy) })
    },
    setBatchConfirmError(value: SetStateAction<CloudTodoWorkspaceState['batchConfirmError']>) {
      update({ batchConfirmError: resolve(value, snapshot.batchConfirmError) })
    },
    setBatchConfirmItems(value: SetStateAction<CloudTodoWorkspaceState['batchConfirmItems']>) {
      update({ batchConfirmItems: resolve(value, snapshot.batchConfirmItems) })
    },
    setBatchConfirmRetryItemKeys(
      value: SetStateAction<CloudTodoWorkspaceState['batchConfirmRetryItemKeys']>
    ) {
      update({ batchConfirmRetryItemKeys: resolve(value, snapshot.batchConfirmRetryItemKeys) })
    },
    setBatchArchiveError(value: SetStateAction<CloudTodoWorkspaceState['batchArchiveError']>) {
      update({ batchArchiveError: resolve(value, snapshot.batchArchiveError) })
    },
    setRuntimeBatchArchiveItems(
      value: SetStateAction<CloudTodoWorkspaceState['runtimeBatchArchiveItems']>
    ) {
      update({ runtimeBatchArchiveItems: resolve(value, snapshot.runtimeBatchArchiveItems) })
    },
    setIssueResourceAttachmentState(
      value: SetStateAction<CloudTodoWorkspaceState['issueResourceAttachmentState']>
    ) {
      update({
        issueResourceAttachmentState: resolve(value, snapshot.issueResourceAttachmentState),
      })
    },
  }
}
