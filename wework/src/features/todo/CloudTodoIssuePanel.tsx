import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { LocatedLoopItem } from './cloudTodoWorkspaceTypes'
import { formatCompactFileSize, selectedTaskBindingAddress } from './cloudTodoWorkspaceSupport'
import { IssueResourceSection } from './CloudTodoWorkspaceControls'
import { issueRuntimePort } from './issueRuntimePort'
import { ArrowLeft, ChevronRight, File, ListTodo, MessageSquare, X } from 'lucide-react'
import type { CloudLoopItem } from '@/api/deliveries'
import { mergeIssueReadConfirmation, type CollaborationIssue } from '@wegent/collaboration'
import { humanTaskDispatchInput, resolveHumanTaskDispatch } from './humanTaskDispatch'
import { cn } from '@/lib/utils'
import { track } from '@/telemetry/client'
import { modelSelectionFromRuntimeHandle } from '@/features/workbench/runtimeContextUsage'
import {
  canEditProjectSpaceIssue,
  projectSpaceRef,
  sameProjectSpace,
} from './projectSpaceSelection'
import { TodoEditor } from './TodoEditor'
import { columnDotClasses } from './todoShared'
import { AiChatModal } from './AiChatModal'
import { workItemComposerReference } from './workItemTaskInput'
import type { CloudTodoWorkspaceViewModel } from './CloudTodoWorkspaceView'
export function CloudTodoIssuePanel({ model }: { model: CloudTodoWorkspaceViewModel }) {
  const {
    user,
    localProjects,
    runtimeWork,
    services,
    onOpenRuntimeTask,
    workspaceSource,
    t,
    workbenchDevices,
    cloudWorkspaceApi,
    deviceNamesById,
    cloudWorkspace,
    selectedProjectRef,
    advanceTaskPanelSession,
    openTaskComposer,
    selectedProject,
    openTaskBinding,
    activeItemTaskBindings,
    taskExecutionStatesByBindingId,
    selectedProjectAgentApi,
    selectedProjectChatClient,
    selectedProjectSelfManagedExecution,
    selectedItemProject,
    selectedItemApi,
    detailAllItems,
    savedViews,
    boardColumns,
    nativeGroupBy,
    aiChatProject,
    selectedItemDefaultLocalProjectId,
    selectedItemTaskRequestProjectId,
    selectedItemTaskDeviceWorkspaceId,
    taskPanelOpen,
    taskStartingInBackground,
    issueResourceAttachments,
    issueResourceAttachmentsLoading,
    closeTaskPanel,
    closeIssuePanelStack,
    selectedItem,
    setSelectedItem,
    setItems,
    backgroundTaskItemId,
    setBackgroundTaskItemId,
    setDetailItems,
    selectedTaskBinding,
    setSelectedTaskBinding,
    taskComposerRequest,
    setTaskComposerRequest,
    taskPanelSessionId,
    setTaskDispatchError,
    boardRefreshNonce,
    setBoardRefreshNonce,
    openTodoCreation,
    createIssueAssignmentTask,
    prepareSelectedItemTask,
    handleSelectedItemTaskCreated,
  } = model
  return (
    <>
      {selectedItem && !taskStartingInBackground ? (
        <div
          data-testid="cloud-todo-panel-stack"
          data-conversation-open={taskPanelOpen ? 'true' : 'false'}
          className={cn('todo-panel-stack', taskPanelOpen && 'has-conversation')}
        >
          {taskPanelOpen && backgroundTaskItemId !== selectedItem.id ? (
            <aside
              data-testid="cloud-todo-compact-issue"
              className="task-conversation-issue-context flex min-h-0 flex-col bg-background"
            >
              <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-todo-compact-issue-back"
                  onClick={closeTaskPanel}
                  aria-label="返回 Issue 详情"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                >
                  <ArrowLeft className="h-4 w-4" />
                </ControlButton>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
                  {selectedItem.id} · Issue 附件
                </span>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-todo-panel-close"
                  onClick={closeIssuePanelStack}
                  aria-label="关闭"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                >
                  <X className="h-4 w-4" />
                </ControlButton>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto py-2">
                <IssueResourceSection
                  icon={<File className="h-3.5 w-3.5" />}
                  title="文件附件"
                  count={issueResourceAttachments.length}
                  empty={issueResourceAttachmentsLoading ? '正在加载…' : '暂无文件附件'}
                >
                  {issueResourceAttachments.map(attachment => (
                    <ControlButton
                      variant="unstyled"
                      key={attachment.id}
                      type="button"
                      data-testid={`cloud-todo-resource-attachment-${attachment.id}`}
                      onClick={() =>
                        void selectedItemApi?.downloadLoopItemAttachment(
                          attachment.id,
                          attachment.display_name,
                          selectedProject && selectedItem
                            ? {
                                projectId: String(selectedProject.id),
                                issueId: selectedItem.id,
                              }
                            : undefined
                        )
                      }
                      className="task-conversation-resource-row"
                    >
                      <File className="h-4 w-4 shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 truncate">{attachment.display_name}</span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {formatCompactFileSize(attachment.size_bytes)}
                      </span>
                    </ControlButton>
                  ))}
                </IssueResourceSection>

                <IssueResourceSection
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  title="任务会话"
                  count={(activeItemTaskBindings[selectedItem.id] ?? []).length}
                  empty="暂无任务会话"
                >
                  {(activeItemTaskBindings[selectedItem.id] ?? []).map(binding => {
                    const selected = selectedTaskBinding?.id === binding.id
                    return (
                      <ControlButton
                        variant="unstyled"
                        key={binding.id}
                        type="button"
                        data-testid={`cloud-todo-resource-conversation-${binding.id}`}
                        data-selected={selected ? 'true' : 'false'}
                        onClick={() => {
                          openTaskBinding({
                            ...binding,
                            work_item_id: selectedItem.id,
                          })
                        }}
                        className={cn('task-conversation-resource-row', selected && 'is-selected')}
                      >
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            selected ? 'bg-primary' : 'bg-text-muted/50'
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {binding.task_title || binding.task_id}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      </ControlButton>
                    )
                  })}
                </IssueResourceSection>

                <IssueResourceSection
                  icon={<ListTodo className="h-3.5 w-3.5" />}
                  title="子 Issue"
                  count={
                    detailAllItems.filter(candidate => candidate.parent_id === selectedItem.id)
                      .length
                  }
                  empty="暂无子 Issue"
                >
                  {detailAllItems
                    .filter(candidate => candidate.parent_id === selectedItem.id)
                    .map(child => (
                      <ControlButton
                        variant="unstyled"
                        key={child.id}
                        type="button"
                        data-testid={`cloud-todo-resource-child-${child.id}`}
                        onClick={() => {
                          closeTaskPanel()
                          setSelectedItem(child)
                        }}
                        className="task-conversation-resource-row"
                      >
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            columnDotClasses[child.status]
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{child.title}</span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      </ControlButton>
                    ))}
                </IssueResourceSection>
              </div>
            </aside>
          ) : null}
          {backgroundTaskItemId !== selectedItem.id &&
          selectedItem.can_view_detail !== false &&
          selectedItem.detail_loaded !== false &&
          (selectedItemProject?.location === 'cloud' ? cloudWorkspaceApi : selectedItemApi) ? (
            <TodoEditor
              key={selectedItem.id}
              commentBoard={
                selectedItemProject &&
                sameProjectSpace(projectSpaceRef(selectedItemProject), selectedProjectRef)
                  ? {
                      columns: boardColumns,
                      groupBy: nativeGroupBy,
                      name: savedViews.view?.name ?? selectedItemProject.name,
                    }
                  : undefined
              }
              getRuntimeTranscript={services.runtimeWorkApi?.getRuntimeTranscript}
              mode="edit"
              presentation="workspace-panel"
              readFirst
              selectedTaskId={
                selectedTaskBinding?.work_item_id === selectedItem.id
                  ? selectedTaskBinding.task_id
                  : null
              }
              {...(selectedItemProject?.location === 'cloud'
                ? { sharedApi: cloudWorkspaceApi! }
                : { api: selectedItemApi! })}
              projectChatAgentApi={selectedProjectAgentApi}
              teamApi={services.teamApi}
              projectChatClient={selectedProjectChatClient}
              selfManagedExecution={selectedProjectSelfManagedExecution}
              currentUserId={selectedItemProject?.current_user_id ?? user.id}
              localProjects={localProjects}
              aitableApi={
                selectedItemProject?.task_provider === 'dingtalk_aitable'
                  ? services.aitableApi
                  : undefined
              }
              item={selectedItem}
              project={selectedItemProject}
              allItems={detailAllItems}
              showChildren={false}
              onAddChild={
                canEditProjectSpaceIssue(selectedItem)
                  ? () => openTodoCreation(selectedItem)
                  : undefined
              }
              onOpenRelatedIssue={related => {
                if (related.can_view_detail === false) return
                closeTaskPanel()
                setSelectedItem({ ...related, project_store: selectedItem.project_store })
              }}
              initialTaskBindings={activeItemTaskBindings[selectedItem.id]}
              taskExecutionStates={taskExecutionStatesByBindingId}
              deviceNamesById={deviceNamesById}
              taskRefreshKey={boardRefreshNonce}
              onOpenChildTask={child => {
                const locatedChild = {
                  ...child,
                  project_store: selectedItem.project_store,
                }
                closeTaskPanel()
                setSelectedItem(locatedChild)
              }}
              existingTaskSource={
                selectedItemProject && issueRuntimePort(selectedItemProject.project_store, services)
                  ? {
                      work: runtimeWork,
                      port: issueRuntimePort(selectedItemProject.project_store, services)!,
                      onLinked: () => setBoardRefreshNonce(value => value + 1),
                    }
                  : undefined
              }
              onCreateTask={async () => {
                if (!selectedItemProject) return
                setTaskDispatchError(null)
                let dispatch: Awaited<ReturnType<typeof resolveHumanTaskDispatch>>
                try {
                  dispatch = await resolveHumanTaskDispatch(
                    selectedProjectChatClient,
                    selectedItemProject.id,
                    selectedItem.id,
                    selectedItemProject.current_user_id ?? user.id
                  )
                } catch (cause) {
                  setTaskDispatchError(
                    t('workbench.issue_task_dispatch_lookup_failed', {
                      reason: cause instanceof Error ? cause.message : String(cause),
                    })
                  )
                  return
                }
                if (dispatch) {
                  createIssueAssignmentTask(selectedItemProject, selectedItem, dispatch, false)
                  return
                }
                setSelectedTaskBinding(null)
                setBackgroundTaskItemId(null)
                openTaskComposer({
                  workItemId: selectedItem.id,
                  initialInput: workItemComposerReference(selectedItemProject, selectedItem),
                  backgroundAfterSend: false,
                })
              }}
              onClose={closeIssuePanelStack}
              onStartHumanTaskFromReply={({ issueId, dispatch }) => {
                if (
                  !selectedItem ||
                  !selectedItemProject ||
                  String(selectedItem.id) !== String(issueId)
                ) {
                  return
                }
                createIssueAssignmentTask(
                  selectedItemProject,
                  selectedItem,
                  humanTaskDispatchInput(dispatch),
                  false
                )
              }}
              onOpenTaskConversation={task => {
                openTaskBinding({
                  ...task,
                  work_item_id: selectedItem.id,
                })
              }}
              onRead={updated => {
                const confirmed =
                  selectedItemProject?.location === 'cloud'
                    ? (cloudWorkspace.commands.confirmIssueRead(
                        updated as CollaborationIssue
                      ) as CloudLoopItem)
                    : updated
                const mergeRead = (item: LocatedLoopItem): LocatedLoopItem =>
                  item.id === updated.id
                    ? {
                        ...mergeIssueReadConfirmation(item, confirmed),
                        project_store: item.project_store,
                      }
                    : item
                if (selectedItemProject?.location === 'local') {
                  setItems(current => current.map(mergeRead))
                  setDetailItems(current => current.map(mergeRead))
                }
                setSelectedItem(current => (current ? mergeRead(current) : current))
              }}
              onUpdated={updated => {
                const locatedUpdated = {
                  ...updated,
                  project_store: selectedItem.project_store,
                }
                if (selectedItemProject?.location === 'cloud') {
                  cloudWorkspace.commands.replaceIssue(updated as CollaborationIssue)
                } else if (selectedItemProject?.location === 'local') {
                  setItems(current =>
                    current.map(item => (item.id === updated.id ? locatedUpdated : item))
                  )
                }
                if (selectedItemProject?.location === 'local') {
                  setDetailItems(current =>
                    current.map(item => (item.id === updated.id ? locatedUpdated : item))
                  )
                }
                setSelectedItem(locatedUpdated)
                track('feature_action_completed', { domain: 'board_item', action: 'update' })
              }}
            />
          ) : selectedItem.detail_loaded === false ? (
            <div
              data-testid="cloud-todo-detail-loading"
              className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-muted"
            >
              {t('todo.loading_work_item_detail')}
            </div>
          ) : null}
          {taskPanelOpen && aiChatProject ? (
            <AiChatModal
              key={
                selectedTaskBinding?.work_item_id === selectedItem.id
                  ? `ai-chat-${selectedItem.id}:${selectedTaskBinding.device_id}:${selectedTaskBinding.task_id}`
                  : `ai-chat-new-${selectedItem.id}`
              }
              project={aiChatProject}
              localProjects={localProjects}
              task={selectedItem}
              initialLocalProjectId={
                taskComposerRequest?.workItemId === selectedItem.id
                  ? (selectedItemTaskRequestProjectId ?? selectedItemDefaultLocalProjectId)
                  : selectedItemDefaultLocalProjectId
              }
              initialDeviceWorkspaceId={selectedItemTaskDeviceWorkspaceId}
              initialTaskRequest={
                taskComposerRequest?.workItemId === selectedItem.id
                  ? taskComposerRequest.taskRequest
                  : undefined
              }
              inheritFromTask={
                taskComposerRequest?.workItemId === selectedItem.id
                  ? taskComposerRequest.inheritFromTask
                  : null
              }
              initialAddress={
                selectedTaskBinding?.work_item_id === selectedItem.id
                  ? selectedTaskBindingAddress(selectedTaskBinding, runtimeWork, workbenchDevices)
                  : null
              }
              taskTitle={
                selectedTaskBinding?.work_item_id === selectedItem.id
                  ? selectedTaskBinding.task_title
                  : null
              }
              open={
                selectedTaskBinding?.work_item_id !== selectedItem.id ||
                backgroundTaskItemId !== selectedItem.id
              }
              embedded
              initialTaskInput={
                taskComposerRequest?.workItemId === selectedItem.id
                  ? taskComposerRequest.initialInput
                  : ''
              }
              onClose={closeIssuePanelStack}
              onBack={closeTaskPanel}
              onAddressChange={address => {
                if (taskPanelSessionId !== workspaceSource.getSnapshot().taskPanelSessionId) return
                const activeTaskComposerRequest =
                  taskComposerRequest?.workItemId === selectedItem.id ? taskComposerRequest : null
                if (!activeTaskComposerRequest) return
                advanceTaskPanelSession()
                if (activeTaskComposerRequest.backgroundAfterSend) {
                  setBackgroundTaskItemId(null)
                  setSelectedItem(null)
                  setSelectedTaskBinding(null)
                } else {
                  setSelectedTaskBinding({
                    id: -Date.now(),
                    task_user_id: selectedItemProject?.current_user_id ?? user.id,
                    device_id: address.deviceId,
                    task_id: address.taskId,
                    task_title: null,
                    modelSelection: modelSelectionFromRuntimeHandle(address.runtimeHandle),
                    work_item_id: selectedItem.id,
                  })
                }
                setTaskComposerRequest(null)
                setBoardRefreshNonce(value => value + 1)
              }}
              prepareTask={prepareSelectedItemTask}
              onTaskCreated={handleSelectedItemTaskCreated}
              onOpenRuntimeTask={onOpenRuntimeTask}
            />
          ) : null}
        </div>
      ) : null}
    </>
  )
}
