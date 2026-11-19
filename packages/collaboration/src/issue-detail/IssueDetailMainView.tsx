import { Button as ControlButton } from '../markdown/Button'
import { IssueHeaderContext } from './IssueHeaderContext'
import { PopoverClose } from '../controls/Popover'
import { Copy, Folder, Maximize2, Minimize2, X } from 'lucide-react'
import { IssuePropertiesPopover } from './IssuePropertiesPopover'
import { IssueSaveButton } from './IssueSaveButton'
import { cn } from './issueEditorSupport'
import type { IssueDetailModel } from './useSharedIssueDetailModel'
import { createIssueDetailProperties } from './issueDetailProperties'
import { IssueDetailExecutionRail } from './IssueDetailExecutionRail'
import { IssueDetailDocumentView } from './IssueDetailDocumentView'
export type IssueDetailViewModel = IssueDetailModel & ReturnType<typeof createIssueDetailProperties>
export function IssueDetailMainView({ model }: { model: IssueDetailModel }) {
  const viewModel = { ...model, ...createIssueDetailProperties(model) }
  const {
    props,
    onClose,
    extensions,
    t,
    createProps,
    editProps,
    isCreate,
    editable,
    workspacePanel,
    showPanelControls,
    showFullscreenControl,
    item,
    isAITableEdit,
    fieldSaves,
    issueDirty,
    title,
    scheduleRangeInvalid,
    projectMembers,
    setDescriptionExpanded,
    saving,
    descriptionDirty,
    savingDescription,
    fullScreen,
    setFullScreen,
    assignmentChainOpen,
    setAssignmentChainOpen,
    assignmentChainTrigger,
    statusHistoryOpen,
    setStatusHistoryOpen,
    statusHistoryAnchor,
    detailScrollRef,
    personalTaskActionPinned,
    titleRef,
    propertiesTriggerRef,
    hasDraftContent,
    canAssign,
    createTitle,
    submitCreate,
    saveDetails,
    handleKeyDown,
    handleDrop,
    twoColumn,
    notificationAvailable,
    notificationSaveLabels,
    statusValue,
    fullScreenReadingColumn,
    fullScreenSectionPadding,
    personalTaskAction,
  } = viewModel
  return (
    <div
      className={cn(
        'flex items-start justify-center',
        workspacePanel
          ? cn(
              'task-detail-workspace-panel-shell relative z-10 h-full min-h-0 shrink-0',
              props.workspacePanelFill && 'task-detail-workspace-panel-fill w-full min-w-0',
              fullScreen && 'is-expanded'
            )
          : fullScreen
            ? 'fixed inset-0 z-modal bg-black/35 p-3 backdrop-blur-sm'
            : twoColumn
              ? 'fixed bottom-0 right-0 top-[38px] z-modal w-[min(760px,calc(100vw-48px))]'
              : 'fixed inset-0 z-modal bg-black/35 px-6 pb-6 pt-[6vh] backdrop-blur-sm'
      )}
      onMouseDown={event => {
        if (!workspacePanel && event.currentTarget === event.target) onClose()
      }}
    >
      <section
        data-testid={isCreate ? 'cloud-todo-create-panel' : 'cloud-todo-detail'}
        data-field-save-state={fieldSaves.pending ? 'pending' : 'idle'}
        aria-busy={fieldSaves.pending || undefined}
        className={cn(
          'flex flex-col overflow-hidden rounded-2xl bg-background shadow-2xl',
          workspacePanel
            ? 'todo-floating-panel-surface h-full w-full max-w-none'
            : fullScreen
              ? 'h-full w-full'
              : cn(
                  'max-w-[calc(100vw-48px)]',
                  twoColumn
                    ? 'h-full w-full max-w-none rounded-none border-l border-border shadow-xl'
                    : cn('max-h-[88vh]', isAITableEdit ? 'w-[1080px]' : 'w-[760px]')
                )
        )}
        onKeyDown={handleKeyDown}
        onDragOver={event => event.preventDefault()}
        onDrop={handleDrop}
      >
        <span className="sr-only">
          {isCreate ? t('todo.new_issue', '新建任务') : t('todo.issue_detail', '任务详情')}
        </span>
        <header
          className={cn(
            'flex shrink-0 items-center',
            twoColumn && !workspacePanel
              ? 'h-12 border-b border-border px-4'
              : workspacePanel
                ? 'task-detail-workspace-header'
                : 'px-4 pt-3'
          )}
        >
          <IssueHeaderContext
            enabled={workspacePanel && Boolean(item)}
            issueId={item?.id ?? ''}
            title={title}
            status={statusValue}
            scrollRef={detailScrollRef}
            titleRef={titleRef}
          >
            <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-xs text-text-secondary">
              <Folder className="h-3.5 w-3.5" />
              <span className="truncate">
                {item
                  ? `${editProps?.project?.name ?? t('todo.project_space', '项目空间')} / ${item.id}`
                  : `${createProps?.project.name} · ${
                      createProps?.initialParent
                        ? t('todo.new_sub_issue', '新建子任务')
                        : t('todo.new_issue', '新建任务')
                    }`}
              </span>
            </span>
          </IssueHeaderContext>
          {item && (
            <ControlButton
              variant="unstyled"
              type="button"
              aria-label={t('todo.copy_issue_id', '复制任务编号')}
              title={t('todo.copy_issue_id', '复制任务编号')}
              onClick={() => void navigator.clipboard?.writeText(item.id)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition hover:bg-muted hover:text-text-primary"
            >
              <Copy className="h-3.5 w-3.5" />
            </ControlButton>
          )}
          {!isCreate &&
          (issueDirty || fieldSaves.pending || fieldSaves.saved || fieldSaves.error) ? (
            <span
              role="status"
              data-testid="issue-save-status"
              className="shrink-0 text-xs text-text-secondary"
            >
              {fieldSaves.pending
                ? t('todo.saving')
                : fieldSaves.error
                  ? t('todo.save_failed')
                  : issueDirty
                    ? t('todo.unsaved_changes')
                    : t('todo.saved')}
            </span>
          ) : null}
          {personalTaskAction && personalTaskActionPinned ? (
            <div
              className="task-detail-persistent-action shrink-0"
              data-testid="issue-persistent-task-action"
            >
              {personalTaskAction}
            </div>
          ) : null}
          {props.headerActions}
          {workspacePanel && item && editable && props.onDelete ? (
            <IssuePropertiesPopover
              triggerRef={propertiesTriggerRef}
              label={t('common.actions', '操作')}
              testIdPrefix="cloud-todo-issue-actions"
            >
              <PopoverClose
                render={
                  <button
                    className="task-detail-more-menu-danger"
                    data-testid="cloud-todo-detail-delete"
                    onClick={() => {
                      propertiesTriggerRef.current?.focus()
                      props.onDelete?.()
                    }}
                    type="button"
                  />
                }
              >
                {props.deleteLabel ?? t('todo.delete_issue', '删除任务')}
              </PopoverClose>
            </IssuePropertiesPopover>
          ) : null}
          {twoColumn && !isCreate && !workspacePanel ? (
            <>
              {(editable || canAssign) && (descriptionDirty || savingDescription) ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-todo-save"
                  disabled={savingDescription}
                  onClick={() => void saveDetails()}
                  className="mr-2 h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                >
                  {savingDescription ? t('todo.saving', '保存中…') : t('common.save', '保存')}
                </ControlButton>
              ) : null}
            </>
          ) : null}
          {showPanelControls ? (
            <>
              {showFullscreenControl ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={
                    isCreate ? 'cloud-todo-create-fullscreen' : 'cloud-todo-detail-fullscreen'
                  }
                  onClick={() =>
                    setFullScreen(current => {
                      const expanded = !current
                      if (expanded && workspacePanel) {
                        setDescriptionExpanded(true)
                      }
                      return expanded
                    })
                  }
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                  aria-label={
                    fullScreen
                      ? workspacePanel
                        ? t('todo.restore_issue_sidebar', '还原侧边栏')
                        : t('todo.exit_full_screen', '退出全屏显示')
                      : workspacePanel
                        ? t('todo.expand_issue_detail', '展开详情')
                        : t('todo.full_screen', '全屏显示')
                  }
                >
                  {fullScreen ? (
                    <Minimize2 className="h-4 w-4" />
                  ) : (
                    <Maximize2 className="h-4 w-4" />
                  )}
                </ControlButton>
              ) : null}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={isCreate ? 'cloud-todo-modal-close' : 'cloud-todo-detail-close'}
                onClick={onClose}
                className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                aria-label={
                  isCreate
                    ? t('common.close', '关闭')
                    : t('todo.close_issue_detail', '关闭任务详情')
                }
              >
                <X className="h-4 w-4" />
              </ControlButton>
            </>
          ) : null}
        </header>

        <div
          className={cn(
            'min-h-0 flex-1',
            twoColumn
              ? workspacePanel
                ? 'task-detail-workspace-layout grid overflow-hidden bg-background'
                : 'grid grid-cols-1 overflow-y-auto bg-background md:grid-cols-[minmax(0,1fr)_320px] md:overflow-hidden'
              : 'overflow-y-auto'
          )}
        >
          <IssueDetailDocumentView model={viewModel} />
          {twoColumn && !workspacePanel ? <IssueDetailExecutionRail model={viewModel} /> : null}
        </div>

        {!twoColumn ? (
          <>
            {isCreate && extensions?.renderCreateOptions ? (
              <div className={cn('shrink-0 border-t border-border py-3', fullScreenSectionPadding)}>
                <div data-testid="cloud-todo-create-options" className={fullScreenReadingColumn}>
                  {extensions.renderCreateOptions({ saving })}
                </div>
              </div>
            ) : null}
            <footer
              className={cn('shrink-0 border-t border-border py-3', fullScreenSectionPadding)}
            >
              <div
                data-testid={isCreate ? 'cloud-todo-create-footer' : 'cloud-todo-detail-footer'}
                className={cn('flex items-center gap-2', fullScreenReadingColumn)}
              >
                <span className="text-xs text-text-secondary">
                  {isCreate
                    ? t('todo.create_shortcut_hint', 'ESC 关闭 · ⌘↵ 创建{{draft}}', {
                        draft: hasDraftContent ? ` · ${t('todo.draft_saved', '草稿已保存')}` : '',
                      })
                    : t('todo.save_shortcut_hint', 'ESC 关闭 · ⌘↵ 保存')}
                </span>
                <span className="flex-1" />
                {isCreate ? (
                  <>
                    <IssueSaveButton
                      testId="cloud-todo-create-confirm"
                      disabled={!createTitle || saving || scheduleRangeInvalid}
                      saving={saving}
                      notificationAvailable={notificationAvailable}
                      labels={notificationSaveLabels}
                      onSave={submitCreate}
                      className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                    >
                      {saving
                        ? t('todo.creating_issue', '正在创建…')
                        : t('todo.create_issue', '创建任务')}
                    </IssueSaveButton>
                  </>
                ) : (
                  <>
                    {(editable || canAssign) && descriptionDirty && (
                      <ControlButton
                        variant="unstyled"
                        type="button"
                        data-testid="cloud-todo-save"
                        disabled={savingDescription}
                        onClick={() => void saveDetails()}
                        className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                      >
                        {savingDescription
                          ? t('todo.saving_issue', '正在保存…')
                          : t('common.save', '保存')}
                      </ControlButton>
                    )}
                  </>
                )}
              </div>
            </footer>
          </>
        ) : null}
      </section>
      {!workspacePanel && assignmentChainOpen && item?.assignment_history?.length
        ? (extensions?.renderAssignmentHistory?.({
            anchor: assignmentChainTrigger,
            entries: item.assignment_history,
            members: projectMembers,
            onClose: () => setAssignmentChainOpen(false),
          }) ?? null)
        : null}
      {statusHistoryOpen && item?.status_history?.length
        ? (extensions?.renderStatusHistory?.({
            anchor: statusHistoryAnchor,
            entries: item.status_history,
            members: projectMembers,
            onClose: () => setStatusHistoryOpen(false),
          }) ?? null)
        : null}
      {viewModel.outsideAssigneeDialog}
    </div>
  )
}
