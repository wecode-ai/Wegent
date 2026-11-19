import { ChevronRight, FileText, Link2, ListTodo } from 'lucide-react'
import { taskDeviceLabel } from './taskBindingPresentation'
import { cn } from './issueEditorSupport'
import { TodoAttachmentSection } from './IssueEditorControls'
import type { IssueDetailViewModel } from './IssueDetailMainView'
export function IssueDetailExecutionRail({ model }: { model: IssueDetailViewModel }) {
  const {
    props,
    editorPort,
    extensions,
    t,
    showChildren,
    editProps,
    editable,
    item,
    statusOptions,
    deliveries,
    openDelivery,
    attachmentBusy,
    attachmentError,
    downloadingAttachmentId,
    allAttachments,
    visibleAttachments,
    effectiveTasks,
    childItems,
    childRailExpanded,
    executionRailExpanded,
    deliveryRailExpanded,
    visibleRailChildren,
    visibleRailTasks,
    visibleRailDeliveries,
    toggleRailSection,
    addAttachments,
    openAttachment,
    downloadAttachment,
    removeAttachment,
    railProps,
    completedChildCount,
  } = model
  return (
    <aside
      data-testid="cloud-todo-detail-activity-rail"
      className="task-detail-slim-rail flex min-h-0 flex-col border-t border-border bg-muted/40 md:border-l md:border-t-0"
    >
      <div className="shrink-0 border-b border-border bg-background px-3 py-2.5">
        <div className="grid grid-cols-1 gap-0.5">{railProps}</div>
      </div>
      {item ? (
        <div className="task-detail-rail-sections">
          {showChildren ? (
            <section className="task-detail-rail-section" data-testid="cloud-todo-children">
              <div className="task-detail-section-label">
                <h3>
                  <ListTodo className="icon" />
                  {t('todo.sub_issues', '子任务')}
                </h3>
                <span className="count">
                  {childItems.length > 0
                    ? `${completedChildCount}/${childItems.length}`
                    : childItems.length}
                </span>
                {editable && editProps?.onAddChild ? (
                  <button
                    type="button"
                    data-testid="cloud-todo-detail-add-child"
                    onClick={editProps.onAddChild}
                    className="add"
                  >
                    ＋ {t('common.add', '添加')}
                  </button>
                ) : null}
              </div>
              {childItems.length > 0 ? (
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${(completedChildCount / childItems.length) * 100}%`,
                    }}
                  />
                </div>
              ) : null}
              {childItems.length === 0 ? (
                <p className="task-detail-rail-empty">{t('todo.no_sub_issues', '暂无子任务')}</p>
              ) : (
                <>
                  <div
                    className={cn(
                      'task-detail-rail-subtasks',
                      childRailExpanded && 'expanded-scroll'
                    )}
                  >
                    {visibleRailChildren.map(child => (
                      <div key={child.id} className="subtask">
                        <span className={cn('checkbox', child.status === 'completed' && 'is-done')}>
                          {child.status === 'completed' ? '✓' : null}
                        </span>
                        <span className="subtask-title">{child.title}</span>
                        <span className="who">
                          {statusOptions.find(option => option.id === child.status)?.name}
                        </span>
                      </div>
                    ))}
                  </div>
                  {childItems.length > 2 && (
                    <button
                      type="button"
                      className="task-detail-rail-more"
                      onClick={() => toggleRailSection('children')}
                    >
                      {childRailExpanded
                        ? t('todo.collapse', '收起')
                        : t('todo.view_all_count', '查看全部 {{count}} 个', {
                            count: childItems.length,
                          })}
                    </button>
                  )}
                </>
              )}
            </section>
          ) : null}
          <TodoAttachmentSection
            attachments={visibleAttachments}
            busy={attachmentBusy}
            error={attachmentError}
            editable={editable}
            compactRail
            totalCount={allAttachments.length}
            downloadingId={downloadingAttachmentId}
            onAdd={addAttachments}
            onReadPreview={editorPort.attachments.read}
            onOpen={openAttachment}
            onDownload={extensions?.openAttachment ? downloadAttachment : undefined}
            onRemove={removeAttachment}
            translate={t}
          />
          <section className="task-detail-rail-section">
            <div className="task-detail-section-label">
              <h3>
                <Link2 className="icon" />
                {t('todo.execution_history', '执行记录')}
              </h3>
              <span className="count">{effectiveTasks.length}</span>
            </div>
            {effectiveTasks.length === 0 ? (
              <p className="task-detail-rail-empty">
                {t('todo.no_local_task', '尚未关联本地任务')}
              </p>
            ) : (
              <>
                <div
                  className={cn(
                    'task-detail-rail-executions',
                    executionRailExpanded && 'expanded-scroll'
                  )}
                >
                  {visibleRailTasks.map(task => (
                    <button
                      key={task.id}
                      type="button"
                      data-testid={`cloud-todo-open-task-conversation-${task.id}`}
                      onClick={() => props.onOpenTaskConversation?.(task)}
                      className="task-detail-rail-execution w-full text-left transition hover:bg-muted"
                    >
                      <span className="task-detail-rail-icon">
                        <Link2 className="icon" />
                      </span>
                      <span className="task-detail-rail-content">
                        <span
                          className="task-detail-rail-name"
                          title={task.task_title || task.task_id}
                        >
                          {task.task_title || task.task_id}
                        </span>
                        <span className="task-detail-rail-detail">
                          <span>{taskDeviceLabel(task, props.deviceNamesById)}</span>
                          <span>{t('todo.linked', '已关联')}</span>
                        </span>
                      </span>
                      <span className="task-detail-rail-badges">
                        <span className="task-detail-mini-badge">
                          {t('workbench.quick_view_conversation', '查看对话')}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                      </span>
                    </button>
                  ))}
                </div>
                {effectiveTasks.length > 2 && (
                  <button
                    type="button"
                    className="task-detail-rail-more"
                    onClick={() => toggleRailSection('executions')}
                  >
                    {executionRailExpanded
                      ? t('todo.collapse', '收起')
                      : t('todo.view_all_count', '查看全部 {{count}} 个', {
                          count: effectiveTasks.length,
                        })}
                  </button>
                )}
              </>
            )}
          </section>
          <section className="task-detail-rail-section">
            <div className="task-detail-section-label">
              <h3>
                <FileText className="icon" />
                {t('todo.deliveries', '交付')}
              </h3>
              <span className="count">{deliveries.length}</span>
            </div>
            {deliveries.length === 0 ? (
              <p className="task-detail-rail-empty">{t('todo.no_deliveries', '暂无交付')}</p>
            ) : (
              <>
                <div
                  className={cn(
                    'task-detail-rail-deliveries',
                    deliveryRailExpanded && 'expanded-scroll'
                  )}
                >
                  {visibleRailDeliveries.map(delivery => (
                    <button
                      key={delivery.id}
                      type="button"
                      onClick={() => void openDelivery(delivery.id)}
                      className="task-detail-rail-delivery w-full text-left"
                    >
                      <span className="task-detail-rail-icon">
                        <FileText className="icon" />
                      </span>
                      <span className="task-detail-rail-name">
                        {delivery.assets.length > 0
                          ? t('todo.attachment_count', '{{count}} 个附件', {
                              count: delivery.assets.length,
                            })
                          : t('todo.delivery_result', '交付结果')}
                      </span>
                      <span className="task-detail-rail-meta">
                        {delivery.delivered_at?.slice(0, 10)}
                      </span>
                    </button>
                  ))}
                </div>
                {deliveries.length > 2 && (
                  <button
                    type="button"
                    className="task-detail-rail-more"
                    onClick={() => toggleRailSection('deliveries')}
                  >
                    {deliveryRailExpanded
                      ? t('todo.collapse', '收起')
                      : t('todo.view_all_count', '查看全部 {{count}} 个', {
                          count: deliveries.length,
                        })}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      ) : null}
    </aside>
  )
}
