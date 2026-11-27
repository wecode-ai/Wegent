import { Checkbox } from '../controls/Checkbox'
import { Button as ControlButton } from '../markdown/Button'
import { SearchableSelect } from '../controls/SearchableSelect'
import type { SearchableSelectOption } from '../controls/SearchableSelect'
import { ConfirmationDialog } from '../controls/ConfirmationDialog'
import { MilestonePicker } from '../milestones/MilestonePicker'
import { collaborationIssueCardPriorityClasses as priorityBadgeClasses } from '../issue-card/priorityBadgeClasses'
import { persistIssueDetailFields } from './persistIssueDetailFields'
import { MAX_TAGS_PER_ITEM } from '../tagging'
import {
  Bot,
  ChevronDown,
  Circle,
  CircleUserRound,
  Flag,
  History,
  ListTodo,
  Plus,
  UserPlus,
  UsersRound,
} from 'lucide-react'
import {
  IssueDetailCollaboratorPicker,
  IssueDetailPrioritySelect,
  IssueDetailStatusSelect,
  issueAssigneeTarget,
  type IssueAssigneeTarget,
} from './index'
import { TagEditor } from './TagEditor'
import { IssuePropertyRow as RailProp } from './IssuePropertyRow'
import { IssueAssignmentHistoryDisclosure } from './IssueAssignmentHistoryDisclosure'
import {
  cn,
  columnDotClasses,
  memberNameById,
  propChipClass,
  overlayControlClass,
  issuePriorityLabels,
} from './issueEditorSupport'
import { ScheduleRangeControl, AvatarMark } from './IssueEditorControls'
import type { IssueDetailModel } from './useSharedIssueDetailModel'
import {
  commentAssigneeValue,
  issueAssignmentOptions,
  issueAssignmentShortcuts,
  type IssueAssignmentShortcut,
} from './issueAssignmentShortcuts'

export function createIssueDetailProperties(model: IssueDetailModel) {
  const {
    props,
    project,
    collections,
    editorPort,
    extensions,
    t,
    showAssignee,
    createProps,
    editProps,
    isCreate,
    editable,
    workspacePanel,
    item,
    createCommentChild,
    statusOptions,
    createMilestoneId,
    setCreateMilestoneId,
    fieldSaves,
    status,
    priority,
    parentId,
    startDate,
    dueDate,
    assigneeTarget,
    outsidePeople,
    assigneeQuery,
    assigneeSearch,
    outsideLabel,
    confirmPersonLabel,
    setAssigneeQuery,
    outsideTargetUser,
    confirmOutsideTarget,
    searchIssueUsers,
    outsideAssignee,
    resolveOutsideAssignee,
    tags,
    notifyAssignee,
    setNotifyAssignee,
    changeProperty,
    setStatus,
    setPriority,
    setDueDate,
    setStartDate,
    scheduleRangeInvalid,
    setTags,
    tagSuggestions,
    deliveries,
    collaborators,
    projectMembers,
    projectAgents,
    projectGroups,
    wegentTeams,
    refreshExecutionArtifacts,
    addingCollaborator,
    setAddingCollaborator,
    collaboratorAvailabilityId,
    collaboratorEditingSupported,
    canEditCollaborators,
    collaboratorAvailabilityNote,
    collaboratorBusy,
    collaboratorError,
    setCollaboratorError,
    saving,
    workspaceAgents,
    fullScreen,
    statusHistoryOpen,
    setStatusHistoryOpen,
    setStatusHistoryTrigger,
    effectiveTasks,
    availableCollaborators,
    parentOptions,
    childItems,
    statusLabel,
    parentItem,
    assigneeName,
    canAssign,
    commentActions,
    assignmentBusy,
    assignmentInFlight,
    assignmentPending,
    assignmentSuccessRevision,
    runIssueAssignment,
    completeIssueAssignment,
    assigneeChanged,
    creator,
    persistAssignee,
    synchronizeAssigneeSource,
    persistShortcutAssignee,
    applyShortcutAssignee,
    addCollaborator,
    removeCollaborator,
  } = model

  // The Xiaohongshu-style split: task content on the left, the comment
  // activity rail on the right. Edit mode with a project always gets this
  // layout so the task detail shape matches the design even before chat
  // connectivity is available.
  const assigneeOptions: SearchableSelectOption<IssueAssigneeTarget>[] = [
    {
      value: '',
      label: t('todo.unassigned', '未指派'),
    },
    ...(!project
      ? (item?.resource_participants ?? []).map(resource => ({
          value: `${resource.kind}:${resource.id}` as IssueAssigneeTarget,
          label: resource.name,
          group: t(resource.kind === 'group' ? 'issue_creation.group' : 'todo.agents'),
        }))
      : []),
    ...projectGroups.map(group => ({
      value: `group:${group.id}` as IssueAssigneeTarget,
      label: group.name,
      group: t('issue_creation.group', '协作小组'),
    })),
    ...(item?.assignee_group_id &&
    !projectGroups.some(group => group.id === item.assignee_group_id) &&
    (project ||
      !item.resource_participants?.some(
        resource => resource.kind === 'group' && String(resource.id) === item.assignee_group_id
      ))
      ? [
          {
            value: `group:${item.assignee_group_id}` as IssueAssigneeTarget,
            label: item.assignee_group_name || item.assignee_group_id,
            group: t('issue_creation.group', '协作小组'),
          },
        ]
      : []),
    ...projectMembers
      .filter(
        member =>
          member.can_be_assignee !== false ||
          ((project?.task_provider ?? 'local') === 'local' && member.role === 'Viewer')
      )
      .map(member => ({
        value: `user:${member.user_id}` as IssueAssigneeTarget,
        label: member.user_name,
        group: t('todo.members', '成员'),
      })),
    ...outsidePeople
      .filter(user => !projectMembers.some(member => member.user_id === user.id))
      .map(user => ({
        value: `user:${user.id}` as IssueAssigneeTarget,
        label: user.user_name,
        group: t('todo.members', '成员'),
        description: outsideLabel,
        searchText: assigneeSearch.users.some(result => result.id === user.id)
          ? assigneeQuery
          : undefined,
      })),
    ...projectAgents.map(agent => ({
      value: `agent:${agent.id}` as IssueAssigneeTarget,
      label: agent.name,
      group: t('todo.agents', '机器人'),
    })),
    ...workspaceAgents.map(agent => ({
      value: `resource:${agent.id}` as IssueAssigneeTarget,
      label: agent.name,
      group: t('todo.workspace_agents', '分组智能体'),
    })),
    ...wegentTeams
      .filter(team => projectAgents.some(agent => agent.teamId === team.id))
      .map(team => ({
        value: `team:${team.id}` as IssueAssigneeTarget,
        label: team.displayName || team.name,
        group: t('todo.agent_teams', 'Wegent 智能体'),
      })),
  ]
  const shortcuts =
    item && canAssign && !assigneeChanged && !assignmentPending
      ? issueAssignmentShortcuts(
          item,
          assigneeOptions,
          assigneeName,
          Boolean(project && (project.task_provider ?? 'local') === 'local'),
          t
        )
      : []
  const changeAssignee = (target: IssueAssigneeTarget) => {
    if (!outsideTargetUser(target)) {
      changeProperty('assigneeTarget', target)
      return
    }
    void confirmOutsideTarget(target).then(approved => {
      if (approved) changeProperty('assigneeTarget', target)
    })
  }
  const selectShortcutAssignee = (shortcut: IssueAssignmentShortcut) => {
    if (shortcut.kind === 'redeliver' || !outsideTargetUser(shortcut.target)) {
      applyShortcutAssignee(shortcut)
      return
    }
    void confirmOutsideTarget(shortcut.target).then(approved => {
      if (approved) applyShortcutAssignee(shortcut)
    })
  }

  async function assignCommentTarget(value: string, owner: number) {
    if (!item || !editProps) return false
    if (!canAssign || saving) throw new Error(t('todo.saving', '保存中…'))
    const shortcut = shortcuts.find(option => option.kind !== 'recent' && option.value === value)
    const target =
      shortcut?.target ??
      assigneeOptions.find(
        option => !option.disabled && commentAssigneeValue(option.value) === value
      )?.value
    if (!target) throw new Error(t('todo.redeliver_assignee_changed', '负责人已变化，请重新选择。'))
    if (shortcut?.kind !== 'redeliver' && !(await confirmOutsideTarget(target))) return false
    if (!collections.isActive(owner)) return false
    const current = synchronizeAssigneeSource(
      await editorPort.issues.get(item.id),
      issueAssigneeTarget(item),
      owner
    )
    if (!current) return false
    const currentTarget = issueAssigneeTarget(current)
    if (!shortcut && currentTarget === target) return
    const updated = shortcut
      ? await persistShortcutAssignee(current, shortcut, currentTarget, owner)
      : await persistAssignee(current, target, true)
    if (!synchronizeAssigneeSource(updated, currentTarget, owner, true)) return false
    completeIssueAssignment(owner)
  }

  const activityView =
    item && editProps && editProps.project?.task_provider !== 'dingtalk_aitable'
      ? extensions?.renderActivity?.({
          commentActions,
          item,
          project: editProps.project,
          editable,
          commentAssignment:
            canAssign || editable
              ? {
                  canAssignCurrent: canAssign,
                  currentAssignee: assigneeChanged ? undefined : (assigneeName ?? undefined),
                  ...(editable && (editProps.project || !item.cloud_project_id)
                    ? {
                        createChild: async (
                          input: import('./useCommentAssignment').CommentChildInput
                        ) => {
                          const target = input.target.includes(':')
                            ? (input.target as IssueAssigneeTarget)
                            : (`user:${input.target}` as IssueAssigneeTarget)
                          if (input.target && !(await confirmOutsideTarget(target)))
                            return false as const
                          return createCommentChild(input)
                        },
                      }
                    : {}),
                  options: assigneeOptions
                    .filter(option => option.value !== '')
                    .map(option => ({
                      ...option,
                      // Preserve the comment selector's existing human target IDs.
                      value: commentAssigneeValue(option.value),
                    })),
                  shortcuts,
                  assignmentBusy,
                  assignmentSuccessRevision,
                  assign: value => runIssueAssignment(owner => assignCommentTarget(value, owner)),
                }
              : undefined,
          tasks: effectiveTasks,
          deliveries,
          members: projectMembers,
          agents: projectAgents,
          selectedTaskId: props.selectedTaskId,
          onExecutionArtifactsChange: refreshExecutionArtifacts,
          onItemChange: updated => {
            if (collections.isActive()) editProps.onUpdated(updated)
          },
        })
      : null
  const twoColumn =
    item !== null &&
    (workspacePanel || editProps?.project !== undefined || item.invited_only === true)

  // Property controls, shared by the single-column chip row and the
  // two-column Xiaohongshu-style rail cells. The overlay select/input keeps
  // every cell editable in place regardless of where it is rendered.
  const destinationStatus = createProps?.draftForm?.destinationStatus
  const propertyTestIds = createProps?.draftForm?.propertyTestIds
  const selectedStatus = destinationStatus?.value ?? status
  const statusSelect = (
    <IssueDetailStatusSelect
      testId={
        (destinationStatus ? propertyTestIds?.destinationStatus : propertyTestIds?.status) ??
        (isCreate ? 'cloud-todo-create-status' : 'cloud-todo-detail-status')
      }
      accessibleLabel={t('todo.issue_status', '状态')}
      value={selectedStatus}
      onChange={destinationStatus?.onChange ?? setStatus}
      disabled={!editable}
      className={overlayControlClass}
      statuses={destinationStatus?.options ?? statusOptions}
      includeUnset={selectedStatus === ''}
    />
  )
  const prioritySelect = (
    <IssueDetailPrioritySelect
      testId={
        propertyTestIds?.priority ??
        (isCreate ? 'cloud-todo-create-priority' : 'cloud-todo-detail-priority')
      }
      accessibleLabel={t('todo.issue_priority', '优先级')}
      value={priority}
      includeNone={
        createProps?.draftForm ? Boolean(project) : !item || Boolean(item.cloud_project_id)
      }
      onChange={setPriority}
      disabled={!editable}
      className={overlayControlClass}
      labels={issuePriorityLabels(t)}
    />
  )
  const assigneeValue = (
    <>
      {assigneeTarget.startsWith('group:') ? (
        <UsersRound aria-hidden="true" size={16} />
      ) : assigneeTarget.startsWith('agent:') || assigneeTarget.startsWith('team:') ? (
        <Bot aria-hidden="true" size={16} />
      ) : (
        <CircleUserRound aria-hidden="true" size={16} />
      )}
      <strong className={cn(workspacePanel ? 'min-w-0 truncate font-medium' : 'font-normal')}>
        {assigneeName ?? t('todo.unassigned', '未指派')}
      </strong>
      {item && !assigneeChanged && !workspacePanel
        ? extensions?.renderAssignmentReceipts?.(item)
        : null}
      {canAssign ? <ChevronDown aria-hidden="true" size={12} /> : null}
    </>
  )
  const assigneeSelect =
    !canAssign && workspacePanel ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">{assigneeValue}</span>
    ) : (
      <>
        <SearchableSelect<IssueAssigneeTarget | IssueAssignmentShortcut['value']>
          testId={isCreate ? 'cloud-todo-create-assignee' : 'cloud-todo-detail-assignee'}
          accessibleLabel={t('todo.assignee', '负责人')}
          appearance={isCreate ? 'outline' : 'property'}
          density={isCreate ? 'default' : 'dense'}
          value={assigneeTarget}
          onSearchChange={setAssigneeQuery}
          searchStatus={
            assigneeSearch.error ? (
              <p role="alert">
                {assigneeSearch.error}
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-todo-assignee-search-retry"
                  className="min-h-11 px-2 text-sm underline md:min-h-8"
                  onClick={assigneeSearch.retry}
                >
                  {t('common.retry', '重试')}
                </ControlButton>
              </p>
            ) : assigneeSearch.loading ? (
              <p role="status">…</p>
            ) : null
          }
          onChange={value => {
            const shortcut = shortcuts.find(option => option.value === value)
            if (shortcut && shortcut.kind !== 'recent') {
              selectShortcutAssignee(shortcut)
              return
            }
            const target =
              shortcut?.target ?? assigneeOptions.find(option => option.value === value)?.value
            if (target !== undefined) changeAssignee(target)
          }}
          disabled={!canAssign || assignmentInFlight}
          className={cn(
            'relative inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-inherit disabled:cursor-default',
            workspacePanel && 'min-w-0 max-w-full'
          )}
          triggerContent={assigneeValue}
          searchPlaceholder={t('todo.search_assignee', '搜索负责人')}
          emptyLabel={t('todo.no_matching_assignee', '没有匹配的负责人')}
          actions={
            isCreate && canAssign
              ? [
                  ...(props.onAddAssigneeMember
                    ? [
                        {
                          label: t('todo.assignee_add_member', '添加人员'),
                          icon: <UserPlus className="h-4 w-4" />,
                          testId: 'cloud-todo-create-assignee-add-member',
                          onSelect: props.onAddAssigneeMember,
                        },
                      ]
                    : []),
                  ...(props.onAddAssigneeAgent
                    ? [
                        {
                          label: t('todo.assignee_add_agent', '添加智能体'),
                          icon: <Bot className="h-4 w-4" />,
                          testId: 'cloud-todo-create-assignee-add-agent',
                          onSelect: props.onAddAssigneeAgent,
                        },
                      ]
                    : []),
                ]
              : undefined
          }
          groupLimit={5}
          showAllLabel={(_group, count) =>
            t('todo.view_all_count', '查看全部 {{count}} 个', { count })
          }
          footer={
            !isCreate && canAssign ? (
              <label className="flex min-h-8 items-center gap-2 text-sm text-text-secondary max-md:min-h-11">
                <Checkbox
                  data-testid="cloud-todo-assignee-notify"
                  checked={notifyAssignee}
                  onCheckedChange={checked => setNotifyAssignee(checked === true)}
                />
                {t('todo.notify_assignee')}
              </label>
            ) : undefined
          }
          options={issueAssignmentOptions(
            shortcuts,
            assigneeOptions,
            'cloud-todo-detail-assignee',
            t
          )}
        />
      </>
    )
  const outsideAssigneeDialog = outsideAssignee && (
    <ConfirmationDialog
      title={confirmPersonLabel}
      subject={outsideAssignee.user_name}
      description={outsideLabel}
      labels={{
        cancel: t('common.cancel', '取消'),
        confirm: t('common.confirm', '确认'),
        pending: t('common.saving', '保存中'),
        failed: t('todo.save_failed', '保存失败'),
      }}
      testIdPrefix="issue-outside-assignee"
      onClose={() => {
        resolveOutsideAssignee(false)
      }}
      onConfirm={async () => {
        resolveOutsideAssignee(true)
      }}
    />
  )
  const notificationAvailable = assigneeTarget.startsWith('user:') && (isCreate || assigneeChanged)
  const notificationSaveLabels = {
    saveAndNotify: t('todo.save_and_notify', '保存并通知'),
    saveWithoutNotification: t('todo.save_without_notification', '仅保存不通知'),
    options: t('todo.save_options', '保存选项'),
  }
  const parentSelect = (
    <SearchableSelect
      testId={isCreate ? 'cloud-todo-create-parent' : 'cloud-todo-detail-parent'}
      accessibleLabel={t('todo.parent_issue', '父任务')}
      value={parentId}
      onChange={value => changeProperty('parentId', value)}
      disabled={!editable}
      className={overlayControlClass}
      searchPlaceholder={t('todo.search_parent_issue', '搜索父任务')}
      emptyLabel={t('todo.no_matching_parent_issue', '没有匹配的父任务')}
      options={[
        {
          value: '',
          label: isCreate
            ? t('todo.top_level_issue', '顶层任务')
            : t('todo.no_parent_issue', '无父任务'),
        },
        ...parentOptions.map(candidate => ({
          value: candidate.id,
          label: `${candidate.id} · ${candidate.title}`,
          searchText: `${candidate.id} ${candidate.title}`,
        })),
      ]}
    />
  )
  const scheduleRangeControl = (triggerClassName: string, showLabel = true) => (
    <ScheduleRangeControl
      startDate={startDate}
      dueDate={dueDate}
      inputType={extensions?.dueDateInputType ?? 'date'}
      editable={editable}
      invalid={scheduleRangeInvalid}
      triggerClassName={triggerClassName}
      showLabel={showLabel}
      startTestId={
        propertyTestIds?.schedule ??
        (isCreate ? 'cloud-todo-create-start-date' : 'cloud-todo-detail-start-date')
      }
      dueTestId={
        propertyTestIds?.due ??
        (isCreate ? 'cloud-todo-create-due-date' : 'cloud-todo-detail-due-date')
      }
      onStartDateChange={
        (createProps?.draftForm ? project : !item || item.cloud_project_id)
          ? setStartDate
          : undefined
      }
      onDueDateChange={setDueDate}
      translate={t}
    />
  )
  const statusValue = (
    <>
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          columnDotClasses[selectedStatus] ?? 'bg-zinc-400'
        )}
      />
      {destinationStatus?.options.find(option => option.id === selectedStatus)?.name ?? statusLabel}
    </>
  )
  const issueSecurityLabel =
    item?.security_level === 'related'
      ? t('todo.issue_security_related', '仅相关人员可见')
      : t('todo.issue_security_open', '项目可访问者可见')
  const priorityValue = (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-px text-xs font-medium',
        priorityBadgeClasses[priority]
      )}
    >
      {t(`todo.priority_${priority}`, priority)}
    </span>
  )
  const collaboratorPreview = collaborators.slice(0, 2)
  const statusChip = (
    <span className={propChipClass}>
      <Circle className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-text-secondary">{t('todo.issue_status', '状态')}</span>
      {statusValue}
      <ChevronDown className="h-3 w-3 text-text-muted" />
      {statusSelect}
    </span>
  )
  const statusHistoryTrigger =
    !workspacePanel && item?.status_history?.length ? (
      <ControlButton
        variant="unstyled"
        ref={setStatusHistoryTrigger}
        type="button"
        data-testid="cloud-todo-status-history-trigger"
        aria-label={t('todo.status_history_trigger', '查看状态历史')}
        aria-expanded={statusHistoryOpen}
        title={t('todo.status_history_trigger', '查看状态历史')}
        onClick={() => setStatusHistoryOpen(current => !current)}
        className="relative z-10 ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-secondary transition hover:bg-muted hover:text-text-primary"
      >
        <History className="h-3.5 w-3.5" />
      </ControlButton>
    ) : null
  const priorityChip = (
    <span className={propChipClass}>
      <Flag className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-text-secondary">{t('todo.issue_priority', '优先级')}</span>
      {priorityValue}
      <ChevronDown className="h-3 w-3 text-text-muted" />
      {prioritySelect}
    </span>
  )
  const tagControls = (
    <TagEditor
      key={item ? `issue:${item.id}` : 'create'}
      testIdPrefix={isCreate ? 'cloud-todo-create-tag' : 'cloud-todo-detail-tag'}
      tags={tags}
      onChange={setTags}
      disabled={!editable}
      suggestions={tagSuggestions}
      lengthErrorLabel={t('todo.tag_name_too_long')}
      tagLimit={{
        max: MAX_TAGS_PER_ITEM,
        errorLabel: t('todo.tag_limit_exceeded'),
      }}
      placeholder={t('todo.add_tag', '添加标签')}
      removeLabel={tag => t('todo.remove_name', '删除 {{name}}', { name: tag })}
    />
  )
  const parentLabel = parentItem
    ? `${parentItem.id} · ${parentItem.title}`
    : isCreate
      ? t('todo.top_level_issue', '顶层任务')
      : t('todo.no_parent_issue', '无父任务')
  const parentChip = (
    <span className={propChipClass}>
      <ListTodo className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-text-muted">{t('todo.parent_issue', '父任务')}</span>
      <span className="max-w-40 truncate">{parentLabel}</span>
      <ChevronDown className="h-3 w-3 text-text-muted" />
      {parentSelect}
    </span>
  )
  // Single-column layout: all props stay as one wrapping chip row.
  const propChips = (
    <>
      {statusChip}
      {statusHistoryTrigger}
      {priorityChip}
      {showAssignee ? (
        <span className={cn(propChipClass, !assigneeName && 'text-text-secondary')}>
          {assigneeSelect}
        </span>
      ) : null}
      {item && (
        <span
          data-testid="cloud-todo-detail-creator"
          className={cn(propChipClass, 'text-text-secondary')}
        >
          <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
          <span className="text-text-secondary">{t('todo.creator', '创建人')}</span>
          <span className="text-text-primary">
            {creator ?? (item.created_by_user_id > 0 ? `#${item.created_by_user_id}` : '—')}
          </span>
        </span>
      )}
      {!twoColumn && (!createProps?.draftForm || project) ? parentChip : null}
      {scheduleRangeControl(cn(propChipClass, !startDate && !dueDate && 'text-text-secondary'))}
    </>
  )
  // Participants and tags remain visible; secondary metadata can be expanded inline.
  const resourceParticipants = Boolean(item?.resource_participants?.length) && (
    <div className="my-2 flex flex-wrap gap-2" data-testid="issue-resource-participants">
      {item?.resource_participants?.map(resource => (
        <span
          key={resource.kind + ':' + resource.id}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm"
        >
          <UsersRound className="h-4 w-4" aria-hidden="true" />
          {resource.name}
        </span>
      ))}
    </div>
  )
  const collaboratorPickerProps = {
    members: availableCollaborators,
    projectMemberIds: new Set(projectMembers.map(member => member.user_id)),
    excludedUserIds: new Set([
      ...collaborators.map(member => member.user_id),
      ...(item && !item.cloud_project_id ? [item.created_by_user_id] : []),
    ]),
    onAdd: addCollaborator,
    searchUsers: editorPort.collaborators.searchUsers ?? searchIssueUsers,
    outsideLabel: item?.cloud_project_id ? outsideLabel : t('taskIssueShare.independentVisibility'),
    retryLabel: t('common.retry', '重试'),
    confirmLabel: confirmPersonLabel,
    cancelLabel: t('common.cancel', '取消'),
    emptyLabel: t('todo.no_matching_collaborator', '没有匹配的参与者'),
    busy: collaboratorBusy,
    label: t('todo.select_project_member', '搜索并选择参与者'),
    addLabel: t('common.add', '添加'),
  }
  const railProps = (
    <>
      <RailProp
        label={t('todo.collaborators', '参与者')}
        clickable={false}
        valueClassName="overflow-visible"
      >
        <span
          className="task-detail-property-collaborators flex min-w-0 items-center"
          data-testid="cloud-todo-collaborators"
        >
          {collaboratorPreview.map((collaborator, index) => (
            <ControlButton
              variant="unstyled"
              key={collaborator.id}
              title={collaborator.user_name}
              type="button"
              aria-label={t('todo.remove_collaborator', '移除参与者 {{name}}', {
                name: collaborator.user_name,
              })}
              disabled={!canEditCollaborators || collaboratorBusy}
              onClick={() => void removeCollaborator(collaborator)}
              className={cn(index > 0 && '-ml-2')}
            >
              <AvatarMark name={collaborator.user_name} index={index + 1} size="sm" />
            </ControlButton>
          ))}
          {collaborators.length > collaboratorPreview.length ? (
            <span className="ml-2">+{collaborators.length - collaboratorPreview.length}</span>
          ) : null}
          {item && (item.cloud_project_id || canEditCollaborators) ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="cloud-todo-add-collaborator"
              aria-label={t('todo.add_collaborator', '添加参与者')}
              aria-describedby={
                !collaboratorEditingSupported ? collaboratorAvailabilityId : undefined
              }
              disabled={!canEditCollaborators}
              onClick={() => {
                setAddingCollaborator(current => !current)
                setCollaboratorError(null)
              }}
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-text-secondary transition hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40',
                collaboratorPreview.length > 0 && '-ml-2'
              )}
            >
              <Plus className="h-3.5 w-3.5" />
            </ControlButton>
          ) : null}
          {collaboratorAvailabilityNote}
          {collaboratorEditingSupported &&
          collaborators.length === 0 &&
          !item?.resource_participants?.length ? (
            <span className="ml-2 text-text-secondary">{t('todo.none', '暂无')}</span>
          ) : null}
        </span>
        {resourceParticipants}
      </RailProp>
      {canEditCollaborators && addingCollaborator ? (
        <IssueDetailCollaboratorPicker
          {...collaboratorPickerProps}
          compact
          className="col-span-full px-2 pb-1"
        />
      ) : null}
      {collaboratorError ? (
        <p className="col-span-full px-2 text-xs text-destructive">{collaboratorError}</p>
      ) : null}
    </>
  )
  const completedChildCount = childItems.filter(child => child.status === 'completed').length
  const workspaceProperties =
    workspacePanel && item ? (
      <section
        className="task-detail-workspace-properties"
        data-testid="cloud-todo-current-assignment"
      >
        <div className="task-detail-workspace-properties-grid">
          {item.cloud_project_id ? (
            <RailProp label={t('todo.parent_issue', '父任务')} control={parentSelect}>
              <span className="task-detail-workspace-tag">{parentLabel}</span>
            </RailProp>
          ) : (
            <RailProp label={t('todo.creator', '创建人')} clickable={false}>
              {creator ?? `#${item.created_by_user_id}`}
            </RailProp>
          )}
          {commentActions?.boardName ? (
            <RailProp label={t('todo.comment_board_position')} clickable={false} wrapValue>
              <span
                data-testid="issue-current-board-position"
                className="flex min-w-0 flex-col gap-1"
              >
                <span className="text-xs text-text-secondary">{commentActions.boardName}</span>
                <span>
                  {commentActions.currentColumns.join(' · ') || t('todo.comment_board_unmatched')}
                </span>
              </span>
            </RailProp>
          ) : null}
          <RailProp label={t('todo.issue_priority', '优先级')} control={prioritySelect}>
            <span className="task-detail-workspace-tag">
              {t(`todo.priority_${priority}`, priority)}
              {editable ? <ChevronDown className="h-3 w-3" /> : null}
            </span>
          </RailProp>
          {showAssignee && item.cloud_project_id ? (
            item.assignment_history?.length ? (
              <IssueAssignmentHistoryDisclosure
                key={item.id}
                entries={item.assignment_history}
                memberName={userId => memberNameById(projectMembers, userId)}
                translate={t}
              />
            ) : (
              <RailProp label={t('todo.assignment', '指派')} clickable={false}>
                <span className="text-text-secondary">{t('todo.none', '暂无')}</span>
              </RailProp>
            )
          ) : null}
        </div>
      </section>
    ) : null

  const fullScreenReadingColumn =
    fullScreen && !workspacePanel ? 'mx-auto w-full max-w-[768px]' : undefined
  const fullScreenSectionPadding = fullScreen && !workspacePanel ? 'px-14' : 'px-5'

  const personalTaskAction =
    workspacePanel && item && props.onCreateTask
      ? extensions?.renderPersonalTaskAction?.({
          item,
          tasks: effectiveTasks,
          onCreateTask: props.onCreateTask,
        })
      : null

  const milestonePicker =
    editorPort.milestones &&
    ['local', 'backend'].includes(
      (createProps?.project ?? editProps?.project)?.task_provider ?? ''
    ) ? (
      <MilestonePicker
        api={editorPort.milestones}
        compact={!isCreate}
        appearance="property"
        projectId={project?.id ?? item?.cloud_project_id ?? ''}
        value={isCreate ? createMilestoneId : (item?.milestone_id ?? null)}
        onMissingValue={isCreate ? () => setCreateMilestoneId(null) : undefined}
        disabled={!editable || saving}
        label={t('todo.milestone', '里程碑')}
        searchLabel={t('todo.search_milestone')}
        emptyLabel={t('todo.no_matching_milestone')}
        noneLabel={t('todo.not_set', '未设置')}
        errorLabel={t('todo.milestone_error', '里程碑操作失败，请重试')}
        retryLabel={t('todo.milestone_retry', '重试')}
        onChange={async value => {
          if (isCreate) {
            setCreateMilestoneId(value)
            return
          }
          await fieldSaves.save('milestone', source =>
            persistIssueDetailFields(source, { milestone_id: value }, editorPort.issues)
          )
        }}
      />
    ) : null
  return {
    outsideAssigneeDialog,
    assigneeOptions,
    activityView,
    twoColumn,
    statusSelect,
    prioritySelect,
    assigneeSelect,
    notificationAvailable,
    notificationSaveLabels,
    parentSelect,
    scheduleRangeControl,
    statusValue,
    issueSecurityLabel,
    priorityValue,
    collaboratorPreview,
    statusChip,
    statusHistoryTrigger,
    priorityChip,
    tagControls,
    parentLabel,
    parentChip,
    propChips,
    resourceParticipants,
    collaboratorPickerProps,
    railProps,
    completedChildCount,
    workspaceProperties,
    fullScreenReadingColumn,
    fullScreenSectionPadding,
    personalTaskAction,
    milestonePicker,
  }
}
