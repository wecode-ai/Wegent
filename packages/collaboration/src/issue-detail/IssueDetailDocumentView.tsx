import { persistIssueDetailFields } from './persistIssueDetailFields'
import { runnerEnvironmentError } from '../execution-environment/runnerEnvironmentError'
import { IssueHierarchySummary } from './IssueHierarchySummary'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  Eye,
  Link2,
  Plus,
  Tag,
  Waypoints,
  X,
} from 'lucide-react'
import { IssueDetailCollaboratorPicker, IssueStatusHistoryList, Tooltip } from './index'
import { stripLocalFileUrlsFromClipboardText } from './clipboardText'
import { IssuePropertyRow as RailProp } from './IssuePropertyRow'
import { IssueSaveButton } from './IssueSaveButton'
import { localizeStandardStatusName } from '../i18n'
import { ExecutionConfigurationNotice } from '../runtime-profile/ExecutionConfigurationNotice'
import { IssueLinkedTasks, IssueDeliveries } from './IssueExecutionLists'
import { taskDeviceLabel } from './taskBindingPresentation'
import { cn, columnDotClasses, memberNameById, overlayControlClass } from './issueEditorSupport'
import { TodoAttachmentSection } from './IssueEditorControls'
import type { IssueDetailViewModel } from './IssueDetailMainView'
export function IssueDetailDocumentView({ model }: { model: IssueDetailViewModel }) {
  const {
    props,
    allItems,
    editorPort,
    extensions,
    t,
    showChildren,
    showAssignee,
    editProps,
    isCreate,
    canStartWork,
    editable,
    workspacePanel,
    readFirst,
    item,
    isAITableEdit,
    project,
    statusOptions,
    fieldSaves,
    editingContent,
    title,
    description,
    status,
    setTitle,
    setDescription,
    deliveries,
    collaborators,
    projectMembers,
    openDelivery,
    setInlinePreviewAttachmentIds,
    addingCollaborator,
    setAddingCollaborator,
    collaboratorAvailabilityId,
    collaboratorEditingSupported,
    canEditCollaborators,
    collaboratorAvailabilityNote,
    collaboratorBusy,
    collaboratorError,
    setCollaboratorError,
    attachmentBusy,
    attachmentError,
    downloadingAttachmentId,
    descriptionExpanded,
    setDescriptionExpanded,
    saveError,
    setSaveError,
    descriptionDirty,
    savingDescription,
    titleInvalid,
    titleErrorId,
    saveTitle,
    assignmentChainOpen,
    setAssignmentChainOpen,
    setAssignmentChainTrigger,
    detailScrollRef,
    personalTaskActionRef,
    titleRef,
    descriptionWidget,
    descriptionOverflowing,
    descriptionId,
    repeatedDescriptionHeading,
    descriptionCanExpand,
    propertiesExpanded,
    setPropertiesExpanded,
    propertiesId,
    beginContentEditing,
    allAttachments,
    visibleAttachments,
    effectiveTasks,
    childItems,
    displayedTasks,
    executionChildItems,
    executionTaskCount,
    hasExecutionDetails,
    executionElapsedMinutes,
    executionElapsedLabel,
    pendingAttachmentRows,
    readPendingAttachment,
    statusLabel,
    canManageIssueSecurity,
    assigneeChanged,
    saveDetails,
    cancelContentEditing,
    removeCollaborator,
    stageFiles,
    removePendingFile,
    addAttachments,
    pasteAttachments,
    openAttachment,
    downloadAttachment,
    removeAttachment,
    activityView,
    twoColumn,
    statusSelect,
    assigneeSelect,
    notificationSaveLabels,
    scheduleRangeControl,
    statusValue,
    issueSecurityLabel,
    statusChip,
    statusHistoryTrigger,
    priorityChip,
    tagControls,
    parentChip,
    propChips,
    resourceParticipants,
    collaboratorPickerProps,
    railProps,
    completedChildCount,
    workspaceProperties,
    fullScreenReadingColumn,
    personalTaskAction,
    milestonePicker,
  } = model
  return (
    <div
      ref={twoColumn ? detailScrollRef : undefined}
      data-testid={twoColumn ? 'cloud-todo-detail-scroll' : undefined}
      className={cn(
        'pb-6 pt-2.5',
        twoColumn ? 'task-detail-left md:min-h-0' : 'px-14',
        workspacePanel && 'task-detail-workspace-panel'
      )}
    >
      <div
        data-testid={isCreate ? 'cloud-todo-create-content' : 'cloud-todo-detail-content'}
        className={cn(twoColumn && 'task-detail-left-inner', fullScreenReadingColumn)}
      >
        {twoColumn && item && !workspacePanel ? (
          <div className="task-detail-id-row">
            <span>{item.id}</span>
            <span>·</span>
            <span>
              {t('todo.created_at_short', undefined, {
                date: item.created_at.slice(5, 10),
              })}
            </span>
            {item.automation ? (
              <>
                <span>·</span>
                <span data-testid="cloud-todo-automation-source">
                  {t('todo.automation_source')} ·{' '}
                  {item.automation.trigger === 'manual'
                    ? t('todo.manual_trigger', '手动触发')
                    : t('todo.scheduled_trigger', '定时触发')}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        <div
          className="task-detail-title-properties space-y-2"
          data-testid="issue-title-properties"
        >
          <div className="min-w-0 flex-1">
            <textarea
              ref={titleRef}
              data-testid={isCreate ? 'cloud-todo-title' : 'cloud-todo-detail-title'}
              aria-label={t('todo.issue_title', '任务标题')}
              aria-required="true"
              aria-invalid={titleInvalid || undefined}
              aria-describedby={titleInvalid ? titleErrorId : undefined}
              autoFocus={isCreate}
              value={title}
              onChange={event => setTitle(event.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={event => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault()
                  void saveTitle()
                }
              }}
              readOnly={!editable}
              rows={1}
              maxLength={255}
              placeholder={t('todo.issue_title_placeholder', '目标或事项标题')}
              className={cn(
                'block w-full resize-none overflow-hidden border-0 bg-transparent font-medium tracking-tight text-text-primary outline-none placeholder:text-text-secondary',
                twoColumn ? 'task-detail-title' : 'py-1.5 text-heading-lg',
                readFirst && !editingContent && 'task-detail-content-readonly',
                readFirst && editable && !editingContent && 'task-detail-content-clickable'
              )}
            />
            {titleInvalid ? (
              <p
                id={titleErrorId}
                data-testid="issue-title-error"
                role="alert"
                className="mt-2 text-sm text-destructive"
              >
                {t('todo.title_required', '请输入事项标题')}
              </p>
            ) : null}
          </div>
          {workspacePanel && item ? (
            <section
              className="task-detail-state-line task-detail-title-state"
              data-testid="cloud-todo-state-summary"
              data-status={status}
              aria-label={t('todo.current_state', '当前状态')}
            >
              <dl className="task-detail-property-grid" data-testid="issue-property-grid">
                <div className="task-detail-property">
                  <dt>{t('todo.issue_status', '状态')}</dt>
                  <dd>
                    <Tooltip
                      label={t(
                        'todo.issue_status_help',
                        '状态：{{value}}。表示 Issue 当前所处的处理阶段。',
                        { value: statusLabel }
                      )}
                      side="bottom"
                      align="start"
                    >
                      <span className="task-detail-state-primary relative">
                        {statusValue}
                        {editable ? <ChevronDown aria-hidden="true" size={12} /> : null}
                        {statusSelect}
                      </span>
                    </Tooltip>
                  </dd>
                </div>
                {showAssignee ? (
                  <div className="task-detail-property">
                    <dt>{t('todo.assignee', '负责人')}</dt>
                    <dd className="task-detail-property-assignee">
                      <span
                        className="task-detail-state-assignee"
                        data-testid="cloud-todo-state-assignee"
                      >
                        {assigneeSelect}
                      </span>
                      {item && !assigneeChanged
                        ? extensions?.renderAssignmentReceipts?.(item)
                        : null}
                    </dd>
                  </div>
                ) : null}
                {milestonePicker ? (
                  <div className="task-detail-property">
                    <dt>{t('todo.milestone', '里程碑')}</dt>
                    <dd>{milestonePicker}</dd>
                  </div>
                ) : null}
                <div className="task-detail-property">
                  <dt>{t('todo.schedule_range', '时间范围')}</dt>
                  <dd>{scheduleRangeControl('task-detail-state-due relative', false)}</dd>
                </div>
              </dl>
              <div className="task-detail-primary-metadata" data-testid="issue-primary-metadata">
                <RailProp label={t('todo.project_tags', '标签')} clickable={false} wrapValue>
                  <span className="task-detail-workspace-tags w-full">{tagControls}</span>
                </RailProp>
                {railProps}
              </div>
              <div className="task-detail-expanded-properties">
                <button
                  type="button"
                  className="task-detail-workspace-properties-toggle"
                  data-testid="cloud-todo-more-properties"
                  aria-expanded={propertiesExpanded}
                  aria-controls={propertiesId}
                  onClick={() => setPropertiesExpanded(current => !current)}
                >
                  {t(propertiesExpanded ? 'todo.collapse_properties' : 'todo.expand_properties')}
                  <ChevronDown
                    className={cn('h-3.5 w-3.5', propertiesExpanded && 'rotate-180')}
                    aria-hidden="true"
                  />
                </button>
                <div
                  id={propertiesId}
                  role="region"
                  aria-label={t('todo.more_properties', '更多信息')}
                  data-testid="cloud-todo-more-properties-popover"
                  hidden={!propertiesExpanded}
                >
                  {workspaceProperties}
                </div>
              </div>
              <div className="task-detail-property-secondary">
                {item && project?.project_store === 'backend' && canManageIssueSecurity ? (
                  <Tooltip
                    label={t(
                      'todo.issue_security_help',
                      '可见范围：{{value}}。控制谁可以查看这个 Issue 的详情。',
                      { value: issueSecurityLabel }
                    )}
                    side="bottom"
                    align="start"
                  >
                    <span className="task-detail-state-security">
                      <Eye aria-hidden="true" size={15} />
                      <strong>{issueSecurityLabel}</strong>
                      <ChevronDown aria-hidden="true" size={12} />
                      <select
                        data-testid="cloud-issue-security-level"
                        aria-label={t('todo.issue_security', '任务可见范围')}
                        className={overlayControlClass}
                        value={item.security_level ?? 'open'}
                        disabled={fieldSaves.pendingFields.has('security')}
                        onChange={async event => {
                          if (!editProps) return
                          setSaveError(null)
                          try {
                            const security = event.target.value as 'open' | 'related'
                            await fieldSaves.save('security', source =>
                              persistIssueDetailFields(
                                source,
                                { security_level: security },
                                editorPort.issues
                              )
                            )
                          } catch (cause) {
                            setSaveError(
                              cause instanceof Error
                                ? cause.message
                                : t('todo.save_issue_failed', '保存任务失败')
                            )
                          }
                        }}
                      >
                        <option value="open">
                          {t('todo.issue_security_open', '项目可访问者可见')}
                        </option>
                        <option value="related">
                          {t('todo.issue_security_related', '仅相关人员可见')}
                        </option>
                      </select>
                    </span>
                  </Tooltip>
                ) : null}
              </div>
              {executionElapsedMinutes !== null ? (
                <span className="task-detail-state-metrics">
                  {executionElapsedMinutes !== null ? (
                    <Tooltip
                      label={t(
                        'todo.execution_duration_help',
                        '执行时长：{{duration}}。从本轮执行开始后持续计时。',
                        { duration: executionElapsedLabel }
                      )}
                      side="bottom"
                    >
                      <span className="task-detail-state-metric">
                        <History aria-hidden="true" size={15} />
                        <strong data-testid="cloud-todo-execution-duration">
                          {executionElapsedLabel}
                        </strong>
                      </span>
                    </Tooltip>
                  ) : null}
                </span>
              ) : null}
            </section>
          ) : (
            <div>{milestonePicker}</div>
          )}
        </div>
        {!workspacePanel ? (
          <div
            className={cn(
              'flex flex-wrap items-center gap-2',
              twoColumn ? 'task-detail-pill-row' : 'mt-3'
            )}
          >
            {twoColumn &&
            (!readFirst || editingContent || descriptionOverflowing || descriptionExpanded) ? (
              <>
                {statusChip}
                {statusHistoryTrigger}
                {priorityChip}
                {tagControls}
              </>
            ) : (
              propChips
            )}
          </div>
        ) : null}

        {!twoColumn ? (
          <div className="mt-2.5 flex items-center gap-2">
            <span className="flex shrink-0 select-none items-center gap-1.5 text-xs text-text-secondary">
              <Tag className="h-3.5 w-3.5" />
              {t('todo.project_tags', '标签')}
            </span>
            {tagControls}
          </div>
        ) : null}

        {twoColumn && !workspacePanel ? (
          <div className="task-detail-meta-line">
            {parentChip}
            {showAssignee ? (
              <span className="task-detail-meta-item relative cursor-pointer">
                {assigneeSelect}
                {item?.assignment_history?.length ? (
                  <button
                    ref={setAssignmentChainTrigger}
                    type="button"
                    data-testid="cloud-todo-assignment-chain-trigger"
                    aria-label={t('todo.assignment_chain_trigger', '查看指派详情')}
                    aria-expanded={assignmentChainOpen}
                    title={t('todo.assignment_chain_trigger', '查看指派详情')}
                    onClick={() => setAssignmentChainOpen(current => !current)}
                    className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-secondary transition hover:bg-muted hover:text-text-primary"
                  >
                    <Waypoints className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </span>
            ) : null}
            {scheduleRangeControl('task-detail-meta-item relative cursor-pointer')}
          </div>
        ) : null}

        {!isAITableEdit ? (
          <div
            onClick={event => {
              if (event.target instanceof Element && event.target.closest('button, a')) {
                return
              }
              beginContentEditing('description')
            }}
            className={cn(
              twoColumn ? 'mt-0' : 'mt-3 min-h-[240px]',
              workspacePanel && 'task-detail-workspace-description',
              readFirst && !editingContent && 'task-detail-content-readonly',
              readFirst && editable && !editingContent && 'task-detail-content-clickable'
            )}
          >
            <div
              id={descriptionId}
              ref={workspacePanel ? descriptionWidget.ref : undefined}
              data-repeated-heading={repeatedDescriptionHeading || undefined}
              data-overflowing={descriptionOverflowing ? 'true' : 'false'}
              className={cn(
                twoColumn && 'task-detail-desc',
                twoColumn && !editingContent && !descriptionExpanded && 'is-collapsed'
              )}
            >
              {extensions?.renderDescriptionEditor?.({
                value: description,
                editable: editable && (!readFirst || editingContent),
                placeholder: t(
                  editable ? 'todo.issue_description_placeholder' : 'todo.no_issue_description'
                ),
                onChange: setDescription,
                onPasteFiles: pasteAttachments,
                readAttachment: attachmentId => editorPort.attachments.read(attachmentId),
                onInlineAttachmentIdsChange: attachmentIds =>
                  setInlinePreviewAttachmentIds(new Set(attachmentIds)),
              }) ?? (
                <textarea
                  data-testid="cloud-todo-detail-description"
                  aria-label={t('todo.issue_description', '任务描述')}
                  value={description}
                  placeholder={t(
                    editable ? 'todo.issue_description_placeholder' : 'todo.no_issue_description'
                  )}
                  onChange={event => setDescription(event.target.value)}
                  readOnly={!editable || (readFirst && !editingContent)}
                  onPaste={event => {
                    if (!editable) return
                    const files = Array.from(event.clipboardData.files)
                    if (files.length === 0) return
                    const pastedText = stripLocalFileUrlsFromClipboardText(
                      event.clipboardData.getData('text/plain')
                    )
                    event.preventDefault()
                    if (pastedText) {
                      const target = event.currentTarget
                      target.setRangeText(
                        pastedText,
                        target.selectionStart,
                        target.selectionEnd,
                        'end'
                      )
                      setDescription(target.value)
                    }
                    void pasteAttachments(files)
                  }}
                  className={cn(
                    'min-h-[240px] w-full resize-y rounded-lg border border-border bg-transparent p-3 text-sm text-text-primary outline-none focus:border-text-muted',
                    readFirst && !editingContent && 'task-detail-description-readonly'
                  )}
                />
              )}
            </div>
            {!readFirst ||
            (workspacePanel && editable) ||
            editingContent ||
            descriptionCanExpand ||
            descriptionExpanded ? (
              <div className="task-detail-desc-footer">
                {twoColumn && !editingContent && (descriptionCanExpand || descriptionExpanded) ? (
                  <button
                    type="button"
                    data-testid="issue-description-toggle"
                    aria-expanded={descriptionExpanded}
                    aria-controls={descriptionId}
                    onClick={() => setDescriptionExpanded(current => !current)}
                    className="task-detail-desc-toggle"
                  >
                    <span>
                      {descriptionExpanded
                        ? t('todo.collapse', '收起')
                        : t('todo.expand_description', '展开描述')}
                    </span>
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 transition-transform',
                        descriptionExpanded && 'rotate-180'
                      )}
                    />
                  </button>
                ) : null}
                <p
                  className={cn(
                    'text-xs text-text-secondary',
                    twoColumn && !workspacePanel && 'hidden',
                    workspacePanel && 'task-detail-desc-hint'
                  )}
                >
                  {t('todo.issue_markdown_hint')}
                </p>
                {workspacePanel && editable && !editingContent ? (
                  <span className="task-detail-desc-actions">
                    <button
                      type="button"
                      data-testid="issue-description-edit"
                      onClick={() => beginContentEditing('description')}
                    >
                      {t('todo.edit_description', '编辑描述')}
                    </button>
                  </span>
                ) : null}
                {workspacePanel && editingContent ? (
                  <span
                    className="task-detail-desc-actions"
                    onClick={event => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      data-testid="cloud-todo-cancel-content-edit"
                      disabled={savingDescription}
                      onClick={cancelContentEditing}
                    >
                      {t('common.cancel', '取消')}
                    </button>
                    <IssueSaveButton
                      testId="cloud-todo-save"
                      className="task-detail-assignment-save"
                      saving={savingDescription}
                      notificationAvailable={false}
                      labels={notificationSaveLabels}
                      disabled={!descriptionDirty || savingDescription}
                      onSave={saveDetails}
                    >
                      {savingDescription ? t('todo.saving', '保存中…') : t('common.save', '保存')}
                    </IssueSaveButton>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {item && props.onOpenRelatedIssue ? (
          <IssueHierarchySummary
            item={item}
            allItems={[
              ...allItems,
              ...childItems.filter(child => !allItems.some(current => current.id === child.id)),
            ]}
            onOpen={props.onOpenRelatedIssue}
            onAddChild={editable ? editProps?.onAddChild : undefined}
            translate={t}
          />
        ) : null}
        {Boolean(saveError || fieldSaves.error) && (
          <p
            role="alert"
            data-testid="cloud-todo-save-error"
            className="mt-2 text-xs text-destructive"
          >
            {saveError ??
              runnerEnvironmentError(fieldSaves.error, t) ??
              (fieldSaves.error instanceof Error
                ? fieldSaves.error.message
                : t('todo.save_issue_failed', '保存任务失败'))}
            {fieldSaves.error ? (
              <button
                type="button"
                data-testid="cloud-todo-field-retry"
                onClick={fieldSaves.retry}
                className="ml-2 underline"
              >
                {t('todo.milestone_retry', '重试')}
              </button>
            ) : null}
          </p>
        )}
        {workspacePanel && item ? (
          <>
            {visibleAttachments.length > 0 || editingContent ? (
              <section
                className="task-detail-context-attachments"
                data-testid="cloud-todo-attachment-footer"
              >
                <TodoAttachmentSection
                  attachments={visibleAttachments}
                  busy={attachmentBusy}
                  error={attachmentError}
                  editable={editable && editingContent}
                  compactRail
                  totalCount={visibleAttachments.length}
                  downloadingId={downloadingAttachmentId}
                  onAdd={addAttachments}
                  onReadPreview={editorPort.attachments.read}
                  onOpen={openAttachment}
                  onDownload={extensions?.openAttachment ? downloadAttachment : undefined}
                  onRemove={removeAttachment}
                  translate={t}
                />
              </section>
            ) : null}

            {canStartWork &&
            !personalTaskAction &&
            props.defaultAssistant &&
            !hasExecutionDetails ? (
              <section
                className="task-detail-default-assistant"
                data-testid="cloud-todo-default-assistant"
              >
                <span className="task-detail-default-assistant-icon" aria-hidden="true">
                  <Bot size={18} />
                </span>
                <span className="task-detail-default-assistant-copy">
                  <strong>{props.defaultAssistant.name}</strong>
                  <small>{props.defaultAssistant.description}</small>
                  {props.defaultAssistant.capabilitySummary ? (
                    <span>{props.defaultAssistant.capabilitySummary}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  data-testid="cloud-todo-start-default-assistant"
                  onClick={() => props.onCreateTask?.()}
                >
                  {t('todo.handoff_to_assistant', '交给{{name}}', {
                    name: props.defaultAssistant.name,
                  })}
                </button>
              </section>
            ) : null}

            <ExecutionConfigurationNotice key={item.id} issue={item} translate={t} />
            {!isCreate ? (
              <>
                <IssueLinkedTasks
                  key={item.id}
                  tasks={displayedTasks}
                  createTaskRef={personalTaskAction ? personalTaskActionRef : undefined}
                  createTaskLabel={t('todo.create_personal_task', '创建任务')}
                  childItems={executionChildItems}
                  statusOptions={statusOptions}
                  statusDotClasses={columnDotClasses}
                  taskExecutionStates={props.taskExecutionStates}
                  deviceNamesById={props.deviceNamesById}
                  selectedTaskId={props.selectedTaskId}
                  showCurrentTaskOnly={props.showCurrentTaskOnly}
                  onCreateTask={
                    canStartWork || personalTaskAction || executionTaskCount > 0
                      ? props.onCreateTask
                      : undefined
                  }
                  linkedTaskAction={props.linkedTaskAction}
                  onOpenTaskConversation={props.onOpenTaskConversation}
                  onOpenChildTask={props.onOpenChildTask}
                  translate={t}
                />
                <IssueDeliveries
                  key={`deliveries-${item.id}`}
                  deliveries={deliveries}
                  getDelivery={editorPort.deliveries.get}
                  memberName={id => memberNameById(projectMembers, id)}
                  onOpen={id => void openDelivery(id)}
                  translate={t}
                />
              </>
            ) : null}
          </>
        ) : null}

        {twoColumn && item && editProps?.project?.task_provider !== 'dingtalk_aitable'
          ? (activityView ?? (
              <section
                data-testid="cloud-todo-detail-activity-rail-empty"
                className="task-detail-comments"
              >
                <header className="task-detail-comments-head">
                  <span className="font-semibold text-text-primary">
                    {t('todo.activity', '动态')}
                  </span>
                </header>
                <div className="task-detail-comments-list text-sm text-text-secondary">
                  {workspacePanel &&
                    item.status_history?.map((entry, index) => (
                      <div
                        key={`${entry.at}-${index}`}
                        data-testid={`cloud-task-status-event-${index}`}
                        className="border-b border-border/60 px-3 py-3"
                      >
                        <IssueStatusHistoryList
                          entries={[entry]}
                          startIndex={index}
                          memberName={userId => memberNameById(projectMembers, userId)}
                          labels={{
                            system: t('todo.status_history_system', '系统/机器人'),
                            unset: t('todo.status_history_unset', '未设置'),
                            initial: t('todo.status_history_initial', '初始状态'),
                            statusName: (id, name) => localizeStandardStatusName(id, name, t),
                            accept: t('todo.status_action_accept', '验收'),
                            action: trigger => t(`todo.status_action_${trigger}`, trigger),
                          }}
                        />
                      </div>
                    ))}
                  {t('todo.activity_unavailable', '动态服务当前不可用')}
                </div>
              </section>
            ))
          : null}

        {isAITableEdit && item && editProps?.project
          ? (extensions?.renderAITableFields?.({
              project: editProps.project,
              item,
            }) ?? null)
          : null}

        {!twoColumn ? (
          <div className="mt-5">
            <TodoAttachmentSection
              attachments={isCreate ? pendingAttachmentRows : visibleAttachments}
              busy={attachmentBusy}
              error={attachmentError}
              editable={editable}
              totalCount={isCreate ? pendingAttachmentRows.length : allAttachments.length}
              downloadingId={downloadingAttachmentId}
              onAdd={isCreate ? stageFiles : addAttachments}
              onReadPreview={isCreate ? readPendingAttachment : editorPort.attachments.read}
              onOpen={isCreate ? undefined : openAttachment}
              onDownload={!isCreate && extensions?.openAttachment ? downloadAttachment : undefined}
              onRemove={isCreate ? removePendingFile : removeAttachment}
              translate={t}
            />
          </div>
        ) : null}

        {item && (
          <>
            {!twoColumn && showChildren ? (
              <section className="mt-7" data-testid="cloud-todo-children">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <h3 className="text-sm font-medium text-text-secondary">
                    {t('todo.sub_issues', '子任务')}
                  </h3>
                  <span className="ml-2 text-xs font-normal text-text-secondary">
                    {twoColumn && childItems.length > 0
                      ? `${completedChildCount}/${childItems.length}`
                      : childItems.length}
                  </span>
                  {editable && editProps?.onAddChild ? (
                    <button
                      type="button"
                      data-testid="cloud-todo-detail-add-child"
                      onClick={editProps.onAddChild}
                      className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary transition hover:bg-muted hover:text-text-primary"
                    >
                      <Plus className="h-3 w-3" /> {t('todo.create_sub_issue', '新建子任务')}
                    </button>
                  ) : null}
                </div>
                {twoColumn && childItems.length > 0 ? (
                  <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-text-primary transition-all"
                      style={{
                        width: `${(completedChildCount / childItems.length) * 100}%`,
                      }}
                    />
                  </div>
                ) : null}
                {childItems.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-sm text-text-secondary">
                    {t('todo.no_sub_issues', '暂无子任务')}
                  </p>
                ) : (
                  <div>
                    {childItems.map(child => (
                      <div
                        key={child.id}
                        className="mb-2 flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            columnDotClasses[child.status]
                          )}
                        />
                        <span className="shrink-0 font-mono text-xs text-text-secondary">
                          {child.id}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{child.title}</span>
                        <span className="shrink-0 text-xs text-text-secondary">
                          {statusOptions.find(option => option.id === child.status)?.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : null}
            {!twoColumn ? (
              <section className="mt-7" data-testid="cloud-todo-collaborators">
                <div className="flex h-8 items-center">
                  <h3 className="text-sm font-semibold">{t('todo.collaborators', '参与者')}</h3>
                  <span className="ml-2 text-xs font-normal text-text-secondary">
                    {collaborators.length + (item.resource_participants?.length ?? 0)}
                  </span>
                  {editable ? (
                    <button
                      type="button"
                      data-testid="cloud-todo-add-collaborator"
                      disabled={!collaboratorEditingSupported}
                      aria-describedby={
                        !collaboratorEditingSupported ? collaboratorAvailabilityId : undefined
                      }
                      onClick={() => {
                        setAddingCollaborator(current => !current)
                        setCollaboratorError(null)
                      }}
                      className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary transition hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Plus className="h-3 w-3" />
                      {t('todo.add_collaborator', '添加参与者')}
                    </button>
                  ) : null}
                </div>
                {collaboratorAvailabilityNote}
                {canEditCollaborators && addingCollaborator && (
                  <IssueDetailCollaboratorPicker {...collaboratorPickerProps} className="mt-2" />
                )}
                {resourceParticipants}
                {collaborators.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-secondary">
                    {t('todo.no_collaborators', '暂无参与者')}
                  </p>
                ) : (
                  <div className="mt-1">
                    {collaborators.map(collaborator => (
                      <div
                        key={collaborator.id}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted/60"
                      >
                        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-text-secondary">
                          {collaborator.user_name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{collaborator.user_name}</span>
                        {collaborator.source !== 'manual' && (
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
                            {t('todo.auto_joined', '自动加入')}
                          </span>
                        )}
                        {canEditCollaborators ? (
                          <button
                            type="button"
                            aria-label={t('todo.remove_collaborator', '移除参与者 {{name}}', {
                              name: collaborator.user_name,
                            })}
                            disabled={collaboratorBusy}
                            onClick={() => void removeCollaborator(collaborator)}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-secondary transition hover:bg-background hover:text-text-primary disabled:opacity-40"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                {collaboratorError && (
                  <p className="mt-2 text-xs text-destructive">{collaboratorError}</p>
                )}
              </section>
            ) : null}
            {!twoColumn ? (
              <>
                <section className="mt-7">
                  <h3 className="flex h-8 items-center text-sm font-semibold">
                    {t('todo.execution_history', '执行记录')}
                  </h3>
                  {effectiveTasks.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-secondary">
                      {t('todo.no_local_task', '尚未关联本地任务')}
                    </p>
                  ) : (
                    <div className="mt-1">
                      {effectiveTasks.map(task => (
                        <div
                          key={task.id}
                          className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors hover:bg-muted/60"
                        >
                          <Link2 className="h-4 w-4 shrink-0 text-text-muted" />
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={task.task_title || task.task_id}
                          >
                            {task.task_title || task.task_id}
                          </span>
                          <span className="shrink-0 text-text-secondary">
                            {taskDeviceLabel(task, props.deviceNamesById)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
                <section className="mt-7">
                  <h3 className="flex h-8 items-center text-sm font-semibold">
                    {t('todo.deliveries', '交付')}
                  </h3>
                  <div className="mt-1 space-y-1">
                    {deliveries.map(delivery => (
                      <button
                        key={delivery.id}
                        type="button"
                        onClick={() => void openDelivery(delivery.id)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-xs transition-colors hover:bg-muted/60"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                        <span>
                          {t('todo.attachment_count', '{{count}} 个附件', {
                            count: delivery.assets.length,
                          })}
                        </span>
                        <span className="ml-auto shrink-0 text-text-secondary">
                          {delivery.delivered_at?.slice(0, 10)}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      </button>
                    ))}
                  </div>
                </section>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
