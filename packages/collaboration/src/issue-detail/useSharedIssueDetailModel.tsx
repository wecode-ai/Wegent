import { useIssueOutsideAssignee } from './useIssueOutsideAssignee'
import { useIssueDetailAttachmentActions } from './useIssueDetailAttachmentActions'
import { useIssueDescriptionOverflow } from './useIssueDescriptionOverflow'
import { useIssuePendingFiles } from './issuePendingFiles'
import { useElementGeometry, useEditorFocusRequest } from '../dom-events'
import { useIssueDetailCollections } from './useIssueDetailCollections'
import { useCommentChildIssue } from './useCommentChildIssue'
import { composerMarkdownText } from '../composer/composerMarkdownParser'
import { useIssueFieldSaves } from './useIssueFieldSaves'
import { useIssueTitleSize } from './useIssueTitleSize'
import { persistIssueDetailFields } from './persistIssueDetailFields'
import { createIssueCommentActions, defaultIssueCommentBoard } from './issueCommentActions'
import { runnerEnvironmentError } from '../execution-environment/runnerEnvironmentError'
import { collectProjectTags } from '../project-board/projectTags'
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from 'react'
import {
  issueExecutionElapsedMinutes,
  isScheduleRangeInvalid,
  issueAssigneeTarget,
  parseIssueAssigneeTarget,
  useIssueDetailDraft,
  type DueDateSourceContext,
  type IssueDetailDraftValue,
  type IssueAssigneeTarget,
  type SharedIssueDetailCreateInput,
} from './index'
import { issueDraftFromText } from '../issueDraft'
import { canAssignCollaborationIssue, canManageCollaborationIssueSecurity } from '../permissions'
import { markdownAttachmentRows } from './attachmentMarkdown'
import { useIssueAssigneeResources } from './useIssueAssigneeResources'
import { useIssueCreation } from './useIssueCreation'
import {
  issueEditorStatuses,
  memberNameById,
  todoDraftKey,
  readTodoDraft,
  descendantIds,
  todoDueDateFromSource,
  type CloudLoopItem,
  type CloudLoopItemCollaborator,
  type AttachmentRow,
  type TodoEditorProps,
} from './issueEditorSupport'
export function useSharedIssueDetailModel(props: TodoEditorProps) {
  const { allItems, onClose } = props
  const editorPort = props.port
  const extensions = props.extensions
  const t = props.translate ?? ((_key: string, fallback = _key) => fallback)
  const showChildren = props.showChildren !== false
  const showAssignee = props.showAssignee !== false
  const createProps = props.mode === 'create' ? props : null
  const draftForm = createProps?.draftForm
  const editProps = props.mode === 'edit' ? props : null
  const isCreate = createProps !== null
  const canStartWork = !isCreate && props.canStartWork !== false && Boolean(props.onCreateTask)
  const editable = (isCreate && !props.closeDisabled) || editProps?.editable === true
  const workspacePanel = props.presentation === 'workspace-panel'
  const readFirst = workspacePanel && props.readFirst === true && !isCreate
  const showPanelControls = props.showPanelControls !== false
  const showFullscreenControl = props.showFullscreenControl !== false
  const item = editProps?.item ?? null
  const creation = useIssueCreation(editorPort)
  const isAITableEdit = item !== null && editProps?.project?.task_provider === 'dingtalk_aitable'
  const project = createProps?.project ?? editProps?.project
  const [commentChildren, setCommentChildren] = useState<CloudLoopItem[]>([])

  const createCommentChild = useCommentChildIssue({
    port: editorPort,
    project,
    parent: item,
    resolveTarget: resolveAssigneeTarget,
    assign: persistAssignee,
    onCreated: child =>
      setCommentChildren(current => [...current.filter(value => value.id !== child.id), child]),
  })
  const statusOptions = issueEditorStatuses(
    project?.board_config?.statuses,
    t,
    !project && Boolean(draftForm || (item && !item.cloud_project_id))
  )

  const draftKey =
    createProps && !createProps.draftForm
      ? todoDraftKey(createProps.project.id, createProps.draftScope ?? createProps.initialStatus)
      : null
  const [draft] = useState(() => (draftKey ? readTodoDraft(draftKey) : null))
  const [createMilestoneId, setCreateMilestoneId] = useState<string | null>(
    draft ? draft.milestoneId : (createProps?.initialMilestoneId ?? null)
  )

  const fieldSaves = useIssueFieldSaves(
    item,
    updated => {
      if (props.mode === 'edit') props.onUpdated(updated)
    },
    extensions?.onSaveError
  )
  const pendingDraftFields = useMemo(
    () =>
      new Set([
        ...fieldSaves.pendingFields,
        ...(fieldSaves.pendingFields.has('schedule') ? ['startDate', 'dueDate'] : []),
      ]),
    [fieldSaves.pendingFields]
  )
  const {
    draft: issueDraft,
    getDraft,
    setField: setIssueDraftField,
    dirty: issueDirty,
    restoredContentDirty,
  } = useIssueDetailDraft({
    source: item,
    storage: draftKey ? { key: draftKey, milestoneId: createMilestoneId } : undefined,
    allowedParentIds: allItems.map(candidate => candidate.id),
    pendingFields: pendingDraftFields,
    initial: draftForm?.initial ?? {
      title: createProps?.initialTitle ?? draft?.title ?? '',
      description: draft?.markdown ?? '',
      status: createProps?.initialStatus ?? 'inbox',
      priority: draft?.priority ?? 'none',
      parentId: draft?.parentId ?? createProps?.initialParent?.id ?? '',
      startDate: draft?.startDate ?? '',
      dueDate: draft?.dueDate ?? '',
      assigneeTarget: draft?.assigneeTarget ?? '',
      tags: draft?.tags ?? createProps?.initialTags ?? [],
    },
    normalizeDescription: extensions?.normalizeDescription,
    startDateFromSource: extensions?.startDateFromSource ?? todoDueDateFromSource,
    dueDateFromSource: extensions?.dueDateFromSource ?? todoDueDateFromSource,
  })
  const [editingContent, setEditingContent] = useState(!readFirst || restoredContentDirty)
  const {
    title,
    description,
    status,
    priority,
    parentId,
    startDate,
    dueDate,
    assigneeTarget,
    tags,
  } = issueDraft

  function setDraftField<K extends keyof IssueDetailDraftValue>(
    field: K,
    value: SetStateAction<IssueDetailDraftValue[K]>
  ) {
    const dirty = setIssueDraftField(field, value)
    draftForm?.onDirtyChange?.(dirty)
  }
  const setTitle = (value: SetStateAction<string>) => setDraftField('title', value)
  const setDescription = (value: SetStateAction<string>) => setDraftField('description', value)
  const [notifyAssignee, setNotifyAssignee] = useState(true)
  function changeProperty<K extends keyof IssueDetailDraftValue>(
    field: K,
    value: SetStateAction<IssueDetailDraftValue[K]>
  ) {
    const next =
      typeof value === 'function'
        ? (value as (current: IssueDetailDraftValue[K]) => IssueDetailDraftValue[K])(
            getDraft()[field]
          )
        : value
    setDraftField(field, next)
    if (
      !item ||
      (!editable && field !== 'assigneeTarget') ||
      (field === 'assigneeTarget' && !canAssign)
    )
      return
    if (field === 'assigneeTarget') {
      void fieldSaves.save(field, async source => {
        let updated
        try {
          updated = await persistAssignee(source, next as IssueAssigneeTarget, notifyAssignee)
        } catch (error) {
          const latest = fieldSaves.getSource() ?? item
          if (runnerEnvironmentError(error, t) && latest?.id === source.id)
            setIssueDraftField('assigneeTarget', current =>
              current === next ? issueAssigneeTarget(latest) : current
            )
          throw error
        }
        if ((fieldSaves.getSource() ?? item)?.id === source.id) {
          setIssueDraftField('assigneeTarget', current =>
            current === next ? issueAssigneeTarget(updated) : current
          )
        }
        return updated
      })
      return
    }
    if (field === 'startDate' || field === 'dueDate') {
      const start = field === 'startDate' ? (next as string) : startDate
      const due = field === 'dueDate' ? (next as string) : dueDate
      if (isScheduleRangeInvalid(start, due)) return
      void fieldSaves.save('schedule', source => {
        const convert = (
          value: string,
          original: string | null,
          from: typeof todoDueDateFromSource,
          to?: (value: string, context: DueDateSourceContext) => string
        ) =>
          value
            ? (to?.(value, {
                sourceValue: original,
                sourceInputValue: from(original),
              }) ?? value)
            : null
        return persistIssueDetailFields(
          source,
          {
            start_at: convert(
              start,
              source.start_at ?? null,
              extensions?.startDateFromSource ?? todoDueDateFromSource,
              extensions?.startDateToSource
            ),
            due_at: convert(
              due,
              source.due_at,
              extensions?.dueDateFromSource ?? todoDueDateFromSource,
              extensions?.dueDateToSource
            ),
          },
          editorPort.issues
        )
      })
      return
    }
    const key = field === 'parentId' ? 'parent_id' : field
    void fieldSaves.save(field, async source => {
      try {
        return await persistIssueDetailFields(
          source,
          { [key]: field === 'parentId' ? next || null : next },
          editorPort.issues
        )
      } catch (error) {
        if (field === 'status' && runnerEnvironmentError(error, t)) {
          const latest = fieldSaves.getSource() ?? item
          if (latest?.id === source.id)
            setIssueDraftField('status', current => (current === next ? latest.status : current))
        }
        throw error
      }
    })
  }
  const setStatus = (value: SetStateAction<CloudLoopItem['status']>) =>
    changeProperty('status', value)
  const setPriority = (value: SetStateAction<CloudLoopItem['priority']>) =>
    changeProperty('priority', value)
  const setDueDate = (value: SetStateAction<string>) => changeProperty('dueDate', value)
  const setStartDate = (value: SetStateAction<string>) => changeProperty('startDate', value)
  const scheduleRangeInvalid = isScheduleRangeInvalid(startDate, dueDate)
  const setTags = (value: SetStateAction<string[]>) => changeProperty('tags', value)
  const tagSuggestions = collectProjectTags(
    createProps?.project ?? editProps?.project ?? {},
    allItems
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const pendingAttachments = useIssuePendingFiles(
    editorPort,
    draftKey
      ? JSON.stringify([
          draftKey,
          project?.project_store,
          props.currentUserId ?? project?.current_user_id,
          project?.access_role,
        ])
      : null
  )
  const { files: pendingFiles, fileId: pendingFileId } = pendingAttachments
  const collections = useIssueDetailCollections(props)
  const {
    deliveries,
    setDeliveries,
    selectedDelivery,
    setSelectedDelivery,
    tasks,
    attachments,
    collaborators,
    setCollaborators,
    projectMembers,
    projectAgents,
    projectGroups,
    wegentTeams,
    refreshExecutionArtifacts,
    openDelivery,
  } = collections
  const [editingDelivery, setEditingDelivery] = useState<{ id: string } | null>(null)

  const [inlinePreviewAttachmentIds, setInlinePreviewAttachmentIds] = useState<Set<string>>(
    new Set()
  )

  const [addingCollaborator, setAddingCollaborator] = useState(false)
  const collaboratorAvailabilityId = useId()
  const collaboratorEditingSupported = editorPort.collaborators.editingSupported !== false
  const canEditCollaborators =
    editable && collaboratorEditingSupported && editorPort.collaborators.canEdit !== false
  const collaboratorAvailabilityNote = !collaboratorEditingSupported ? (
    <span
      id={collaboratorAvailabilityId}
      data-testid="issue-collaborators-unavailable"
      className="min-w-0 max-w-full whitespace-normal break-words text-xs text-text-secondary"
    >
      {t('todo.collaborators_unavailable', '此项目暂不支持编辑参与者')}
    </span>
  ) : null
  const outside = useIssueOutsideAssignee(props, item, projectMembers)
  const [collaboratorBusy, setCollaboratorBusy] = useState(false)
  const [collaboratorError, setCollaboratorError] = useState<string | null>(null)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [expandedRailSections, setExpandedRailSections] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const descriptionDirty = Boolean(
    item &&
    description !==
      (extensions?.normalizeDescription ?? ((value: string) => value))(item.description ?? '')
  )
  const savingDescription = fieldSaves.pendingFields.has('description')
  const titleScope = `${isCreate ? 'create' : 'edit'}:${project?.id ?? ''}:${item?.id ?? ''}`
  const [invalidTitleScope, setInvalidTitleScope] = useState<string | null>(null)
  const titleInvalid = invalidTitleScope === titleScope && !title.trim()
  const titleErrorId = useId()
  async function saveTitle() {
    if (!editable) return
    if (!title.trim()) {
      setInvalidTitleScope(titleScope)
      fieldSaves.discardFailure('title')
      return
    }
    setInvalidTitleScope(null)
    if (!item) return
    const next = title.trim()
    setTitle(next)
    if (next === (fieldSaves.getSource() ?? item).title && !fieldSaves.pendingFields.has('title')) {
      fieldSaves.discardFailure('title')
      return
    }
    await fieldSaves.save('title', source =>
      persistIssueDetailFields(source, { title: next }, editorPort.issues)
    )
  }

  const workspaceAgents = useIssueAssigneeResources(
    editorPort,
    item?.invited_only ? undefined : project,
    setSaveError,
    item?.assignee_agent_id
  )
  const [fullScreen, setFullScreen] = useState(false)
  const [assignmentChainOpen, setAssignmentChainOpen] = useState(false)
  const [assignmentChainTrigger, setAssignmentChainTrigger] = useState<HTMLButtonElement | null>(
    null
  )
  const [statusHistoryOpen, setStatusHistoryOpen] = useState(false)
  const [statusHistoryAnchor, setStatusHistoryTrigger] = useState<HTMLButtonElement | null>(null)
  const detailScrollRef = useRef<HTMLDivElement>(null)
  const personalTaskActionRef = useRef<HTMLButtonElement>(null)
  const canPinPersonalTaskAction = Boolean(
    workspacePanel && item && props.onCreateTask && extensions?.renderPersonalTaskAction
  )

  const personalTaskGeometry = useElementGeometry(
    [personalTaskActionRef, detailScrollRef],
    canPinPersonalTaskAction
  )
  const [personalAnchor, personalRoot] = personalTaskGeometry?.elements ?? []
  const personalTaskActionPinned = Boolean(
    canPinPersonalTaskAction &&
    personalAnchor &&
    personalRoot &&
    personalAnchor.bottom <= personalRoot.top
  )
  const titleRef = useIssueTitleSize({
    value: title,
    issueId: item?.id ?? null,
    editing: editingContent,
    expanded: fullScreen,
    workspacePanel,
  })
  const descriptionWidget = useIssueDescriptionOverflow(
    workspacePanel && !descriptionExpanded,
    description
  )
  const descriptionCollapseRef = descriptionWidget.target
  const descriptionOverflowing = descriptionWidget.overflowing
  const descriptionId = useId()
  const repeatedDescriptionHeading = useMemo(() => {
    if (!workspacePanel || editingContent) return false
    const heading = composerMarkdownText(description, { firstLine: true })
    return heading === title.trim() && composerMarkdownText(description) !== heading
  }, [description, editingContent, title, workspacePanel])
  const descriptionCanExpand = descriptionOverflowing || repeatedDescriptionHeading
  const propertiesTriggerRef = useRef<HTMLButtonElement>(null)
  const [propertiesExpanded, setPropertiesExpanded] = useState(false)
  const propertiesId = useId()
  const [contentFocusRequest, setContentFocusRequest] = useState<{
    target: 'title' | 'description'
  } | null>(null)

  const beginContentEditing = useCallback(
    (target: 'title' | 'description') => {
      if (!readFirst || !editable || editingContent) return
      setContentFocusRequest({ target })
      setDescriptionExpanded(true)
      setEditingContent(true)
    },
    [editable, editingContent, readFirst, setDescriptionExpanded, setEditingContent]
  )

  const contentFocusTarget = useMemo(
    () => ({
      get current() {
        const element =
          contentFocusRequest?.target === 'title'
            ? titleRef.current
            : (descriptionCollapseRef.current?.querySelector<HTMLElement>(
                '[contenteditable="true"], textarea'
              ) ?? null)
        return element
          ? {
              element,
              focus() {
                element.focus()
                if (
                  element instanceof HTMLTextAreaElement &&
                  contentFocusRequest?.target === 'title'
                )
                  element.setSelectionRange(element.value.length, element.value.length)
              },
            }
          : null
      },
    }),
    [contentFocusRequest, descriptionCollapseRef, titleRef]
  )
  useEditorFocusRequest(contentFocusTarget, contentFocusRequest, {
    enabled: editingContent && contentFocusRequest !== null,
  })
  const editItemId = item?.id ?? null
  const attachmentActions = useIssueDetailAttachmentActions({
    editorPort,
    extensions,
    t,
    editable,
    editItemId,
    collections,
    pendingAttachments,
    isCreate,
  })
  const allAttachments = useMemo(() => {
    const merged = new Map<string, AttachmentRow>()
    markdownAttachmentRows(description).forEach(attachment =>
      merged.set(attachment.id, { ...attachment, content_type: null })
    )
    attachments.forEach(attachment => merged.set(attachment.id, attachment))
    return Array.from(merged.values())
  }, [attachments, description])
  const visibleAttachments = useMemo(() => {
    const inlineAttachmentIds = new Set(
      markdownAttachmentRows(description).map(attachment => attachment.id)
    )
    return allAttachments.filter(
      attachment =>
        !inlineAttachmentIds.has(attachment.id) || !inlinePreviewAttachmentIds.has(attachment.id)
    )
  }, [allAttachments, description, inlinePreviewAttachmentIds])
  const effectiveTasks = useMemo(() => {
    if (!props.initialTaskBindings) return tasks
    const initialTaskIds = new Set(props.initialTaskBindings.map(task => String(task.id)))
    return [
      ...props.initialTaskBindings,
      ...tasks.filter(task => !initialTaskIds.has(String(task.id))),
    ]
  }, [props.initialTaskBindings, tasks])

  const availableCollaborators = projectMembers.filter(
    member => !collaborators.some(collaborator => collaborator.user_id === member.user_id)
  )
  const excludedParentIds = item ? descendantIds(allItems, item.id) : new Set<string>()
  if (item) excludedParentIds.add(item.id)
  const parentOptions = allItems.filter(candidate => !excludedParentIds.has(candidate.id))
  const childItems = item
    ? [
        ...new Map([...commentChildren, ...allItems].map(child => [child.id, child])).values(),
      ].filter(
        candidate =>
          candidate.parent_id === item.id && candidate.cloud_project_id === item.cloud_project_id
      )
    : []
  const itemHasActiveTask = item ? (extensions?.isExecutionActive?.(item) ?? false) : false
  const displayedTasks = props.showCurrentTaskOnly
    ? itemHasActiveTask
      ? effectiveTasks.slice(0, 1)
      : []
    : effectiveTasks
  const executionChildItems = showChildren || props.onOpenRelatedIssue ? [] : childItems
  const executionTaskCount = executionChildItems.length + displayedTasks.length
  const hasExecutionDetails =
    executionTaskCount > 0 || deliveries.length > 0 || (showChildren && childItems.length > 0)
  const executionElapsedMinutes = issueExecutionElapsedMinutes(item?.ai_state)
  const executionElapsedLabel =
    executionElapsedMinutes === null
      ? t('todo.not_started', '未开始')
      : executionElapsedMinutes < 60
        ? t('todo.elapsed_minutes', '{{count}} 分钟', {
            count: executionElapsedMinutes,
          })
        : executionElapsedMinutes < 1440
          ? t('todo.elapsed_hours', '{{count}} 小时', {
              count: Math.floor(executionElapsedMinutes / 60),
            })
          : t('todo.elapsed_days', '{{count}} 天', {
              count: Math.floor(executionElapsedMinutes / 1440),
            })
  const hasDraftContent = Boolean(
    title ||
    description ||
    priority !== 'none' ||
    parentId ||
    startDate ||
    dueDate ||
    assigneeTarget ||
    tags.length > 0 ||
    pendingFiles.length > 0
  )
  const pendingAttachmentRows: AttachmentRow[] = pendingFiles.map(file => ({
    id: pendingFileId(file),
    display_name: file.name,
    content_type: file.type || null,
    size_bytes: file.size,
  }))
  const readPendingAttachment = useCallback(
    async (attachmentId: string) => {
      const file = pendingFiles.find(candidate => pendingFileId(candidate) === attachmentId)
      if (!file) throw new Error('Pending attachment is unavailable')
      return file
    },
    [pendingFileId, pendingFiles]
  )
  const childRailExpanded = Boolean(expandedRailSections.children)
  const executionRailExpanded = Boolean(expandedRailSections.executions)
  const deliveryRailExpanded = Boolean(expandedRailSections.deliveries)
  const visibleRailChildren = childRailExpanded ? childItems : childItems.slice(0, 2)
  const visibleRailTasks = executionRailExpanded ? effectiveTasks : effectiveTasks.slice(0, 2)
  const visibleRailDeliveries = deliveryRailExpanded ? deliveries : deliveries.slice(0, 2)
  const toggleRailSection = (section: 'children' | 'executions' | 'deliveries') => {
    setExpandedRailSections(current => ({
      ...current,
      [section]: !current[section],
    }))
  }
  const statusLabel =
    statusOptions.find(option => option.id === status)?.name ?? t('todo.not_set', '未设置')
  const parentItem = allItems.find(candidate => candidate.id === parentId)
  const assignee = projectMembers.find(member => assigneeTarget === `user:${member.user_id}`)
  const assigneeAgent = projectAgents.find(agent => assigneeTarget === `agent:${agent.id}`)
  const assigneeResource = workspaceAgents.find(agent => assigneeTarget === `resource:${agent.id}`)
  const assigneeTeam = wegentTeams.find(team => assigneeTarget === `team:${team.id}`)
  const assigneeGroup = projectGroups.find(group => assigneeTarget === `group:${group.id}`)
  const assigneeName =
    assigneeGroup?.name ||
    assigneeTeam?.displayName ||
    assigneeTeam?.name ||
    assigneeAgent?.name ||
    assigneeResource?.name ||
    assignee?.user_name ||
    (item && assigneeTarget && assigneeTarget === issueAssigneeTarget(item)
      ? assigneeTarget.startsWith('group:')
        ? item.assignee_group_name
        : assigneeTarget.startsWith('team:')
          ? item.assignee_team_name
          : assigneeTarget.startsWith('agent:')
            ? item.assignee_agent_name
            : item.assignee_name
      : null) ||
    (assigneeTarget ? assigneeTarget.slice(assigneeTarget.indexOf(':') + 1) : null)
  const canAssign =
    props.canAssign ??
    (item?.invited_only === true ||
      (project !== undefined &&
        (item === null || item.can_view_detail !== false) &&
        canAssignCollaborationIssue(project)))
  const commentActions =
    item && editProps && (editable || canAssign)
      ? createIssueCommentActions({
          issue: item,
          board: project
            ? (props.commentBoard ?? defaultIssueCommentBoard(project, allItems, statusOptions, t))
            : undefined,
          statuses: statusOptions,
          editable,
          canAssign,
          currentUserId: props.currentUserId ?? project?.current_user_id,
          confirmAssignee: target => outside.confirmOutsideTarget(target as IssueAssigneeTarget),
          issues: editorPort.issues,
          onUpdated: updated => {
            if (collections.isActive()) editProps.onUpdated(updated)
          },
          translate: t,
        })
      : undefined
  const canManageIssueSecurity =
    project !== undefined && canManageCollaborationIssueSecurity(project)
  const assigneeChanged = item !== null && assigneeTarget !== issueAssigneeTarget(item)
  const creator =
    item?.created_by_user_name ||
    (item && item.created_by_user_id === editProps?.project?.current_user_id
      ? editProps?.project?.current_user_name
      : item
        ? memberNameById(projectMembers, item.created_by_user_id)
        : null)
  const createTitle = title.trim() || issueDraftFromText(description).title

  async function submitCreate(notifyAssignee = true) {
    if (props.mode !== 'create' || !createTitle || saving || scheduleRangeInvalid) return
    if (props.draftForm && !title.trim()) return
    setSaving(true)
    setSaveError(null)
    if (props.draftForm) {
      try {
        await props.draftForm.submit(getDraft())
      } catch (cause) {
        if (collections.isActive())
          setSaveError(cause instanceof Error ? cause.message : t('todo.save_issue_failed'))
      } finally {
        if (collections.isActive()) setSaving(false)
      }
      return
    }
    const createInput: SharedIssueDetailCreateInput = {
      title: createTitle,
      description,
      priority,
      status,
      tags,
    }
    const startAt = startDate
      ? (extensions?.startDateToSource?.(startDate, {
          sourceValue: null,
          sourceInputValue: '',
        }) ?? startDate)
      : ''
    const dueAt = dueDate
      ? (extensions?.dueDateToSource?.(dueDate, {
          sourceValue: null,
          sourceInputValue: '',
        }) ?? dueDate)
      : ''
    const creatorName =
      props.project.current_user_name ||
      memberNameById(projectMembers, props.project.current_user_id ?? null)
    const createAssignee = parseIssueAssigneeTarget(assigneeTarget)
    const hasHumanAssignee = assigneeTarget.startsWith('user:')
    Object.assign(createInput, {
      ...(createMilestoneId ? { milestone_id: createMilestoneId } : {}),
      ...(parentId ? { parent_id: parentId } : {}),
      ...(startAt ? { start_at: startAt } : {}),
      ...(dueAt ? { due_at: dueAt } : {}),
      ...(creatorName ? { creator_name: creatorName } : {}),
      ...(hasHumanAssignee
        ? {
            assignee_user_id: createAssignee.assigneeUserId,
            notify_assignee: notifyAssignee,
          }
        : {}),
    })
    const create = async (
      overrides: Partial<SharedIssueDetailCreateInput> = {}
    ): Promise<CloudLoopItem> => {
      const target = await resolveAssigneeTarget(assigneeTarget)
      if (!collections.isActive()) throw new Error('Issue editor scope changed')
      const progress = await creation.create(
        props.project.id,
        { ...createInput, ...overrides },
        Boolean(target)
      )
      let created = progress.issue
      if (!collections.isActive()) return created
      // Human ownership must be part of creation so task.created automation
      // cannot start AI work before a follow-up assignment reaches the server.
      if (progress.syncAssignee && target !== issueAssigneeTarget(created)) {
        created = await persistAssignee(created, target, notifyAssignee)
      }
      if (!collections.isActive()) return created
      await creation.upload(created.id, pendingFiles)
      if (!collections.isActive()) return created
      if (draftKey) {
        localStorage.removeItem(draftKey)
        pendingAttachments.clearPersisted()
      }
      await props.onCreated(created)
      return created
    }
    try {
      await create()
    } catch (cause) {
      if (!collections.isActive()) return
      const handled = await props.onCreateError?.(cause, async (overrides = {}) => {
        setSaving(true)
        setSaveError(null)
        try {
          return await create(overrides)
        } finally {
          setSaving(false)
        }
      })
      if (handled) return
      setSaveError(
        cause instanceof Error ? cause.message : t('todo.create_issue_failed', '创建任务失败')
      )
    } finally {
      setSaving(false)
    }
  }

  async function resolveAssigneeTarget(target: IssueAssigneeTarget): Promise<IssueAssigneeTarget> {
    if (!target.startsWith('resource:')) return target
    if (!project || !editorPort.agentResources) throw new Error('Workspace Agent is not available')
    if (!collections.isActive()) throw new Error('Issue editor scope changed')
    const id = await editorPort.agentResources.bind(project, target.slice(9))
    return `agent:${id}`
  }

  async function persistAssignee(
    source: CloudLoopItem,
    selectedTarget: IssueAssigneeTarget,
    shouldNotify: boolean
  ): Promise<CloudLoopItem> {
    const target = await resolveAssigneeTarget(selectedTarget)
    if (!collections.isActive()) throw new Error('Issue editor scope changed')
    if (!target)
      return editorPort.issues.update(source.id, {
        version: source.version,
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
        ...(source.assignee_group_id ? { assignee_group_id: null } : {}),
      })
    if (target.startsWith('group:')) {
      return editorPort.issues.update(source.id, {
        version: source.version,
        assignee_group_id: target.slice(6),
      })
    }
    const { assigneeUserId, assigneeAgentId, assigneeTeamId } = parseIssueAssigneeTarget(target)
    const self = props.currentUserId ?? project?.current_user_id
    return editorPort.issues.update(source.id, {
      version: source.version,
      ...(assigneeUserId == null
        ? assigneeAgentId == null
          ? { assignee_team_id: assigneeTeamId }
          : { assignee_agent_id: assigneeAgentId }
        : {
            assignee_user_id: assigneeUserId,
            notify_assignee: shouldNotify && String(assigneeUserId) !== String(self),
          }),
    })
  }

  async function saveDetails() {
    if (!item || !editable || !descriptionDirty || savingDescription) return
    const updated = await fieldSaves.save('description', source =>
      persistIssueDetailFields(source, { description }, editorPort.issues)
    )
    if (updated && readFirst && getDraft().description === description) {
      setEditingContent(false)
      setDescriptionExpanded(false)
    }
  }

  function cancelContentEditing() {
    if (!item || savingDescription) return
    fieldSaves.discardFailure('description')
    const source = fieldSaves.getSource() ?? item
    setDescription(
      (extensions?.normalizeDescription ?? ((value: string) => value))(source.description ?? '')
    )
    setSaveError(null)
    setEditingContent(false)
    setDescriptionExpanded(false)
  }

  async function addCollaborator(ids: number[]) {
    if (!canEditCollaborators || !editItemId || !ids.length || collaboratorBusy) return
    setCollaboratorBusy(true)
    setCollaboratorError(null)
    const owner = collections.getOwner()
    try {
      for (const id of ids) {
        const collaborator = await editorPort.collaborators.add(editItemId, id)
        if (collections.isActive(owner))
          setCollaborators(current => [
            ...current.filter(entry => entry.user_id !== id),
            collaborator,
          ])
      }
      if (collections.isActive(owner)) setAddingCollaborator(false)
    } catch (cause) {
      if (!collections.isActive(owner)) return
      setCollaboratorError(
        cause instanceof Error ? cause.message : t('todo.add_collaborator_failed', '添加参与者失败')
      )
      throw cause
    } finally {
      if (collections.isActive(owner)) setCollaboratorBusy(false)
    }
  }

  async function removeCollaborator(collaborator: CloudLoopItemCollaborator) {
    if (!canEditCollaborators || !editItemId || collaboratorBusy) return
    setCollaboratorBusy(true)
    setCollaboratorError(null)
    try {
      await editorPort.collaborators.remove(editItemId, collaborator.user_id)
      if (!collections.isActive()) return
      setCollaborators(current => current.filter(entry => entry.id !== collaborator.id))
    } catch (cause) {
      setCollaboratorError(
        cause instanceof Error
          ? cause.message
          : t('todo.remove_collaborator_failed', '移除参与者失败')
      )
    } finally {
      setCollaboratorBusy(false)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    // Portaled controls own their keyboard events even though React bubbles them here.
    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      ;(props.onEscape ?? onClose)()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (isCreate) void submitCreate()
      else void saveDetails()
    }
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    if (draftForm) return
    if (isCreate) void attachmentActions.stageFiles(event.dataTransfer.files)
    else if (editable) void attachmentActions.addAttachments(event.dataTransfer.files)
  }
  return {
    ...outside,
    ...attachmentActions,
    props,
    allItems,
    onClose,
    editorPort,
    extensions,
    t,
    showChildren,
    showAssignee,
    createProps,
    editProps,
    isCreate,
    canStartWork,
    editable,
    workspacePanel,
    readFirst,
    showPanelControls,
    showFullscreenControl,
    item,
    isAITableEdit,
    project,
    createCommentChild,
    statusOptions,
    createMilestoneId,
    setCreateMilestoneId,
    fieldSaves,
    issueDirty,
    editingContent,
    title,
    description,
    status,
    priority,
    parentId,
    startDate,
    dueDate,
    assigneeTarget,
    tags,
    setTitle,
    setDescription,
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
    collections,
    deliveries,
    setDeliveries,
    selectedDelivery,
    setSelectedDelivery,
    collaborators,
    projectMembers,
    projectAgents,
    projectGroups,
    wegentTeams,
    refreshExecutionArtifacts,
    openDelivery,
    editingDelivery,
    setEditingDelivery,
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
    descriptionExpanded,
    setDescriptionExpanded,
    saving,
    saveError,
    setSaveError,
    descriptionDirty,
    savingDescription,
    titleInvalid,
    titleErrorId,
    saveTitle,
    workspaceAgents,
    fullScreen,
    setFullScreen,
    assignmentChainOpen,
    setAssignmentChainOpen,
    assignmentChainTrigger,
    setAssignmentChainTrigger,
    statusHistoryOpen,
    setStatusHistoryOpen,
    statusHistoryAnchor,
    setStatusHistoryTrigger,
    detailScrollRef,
    personalTaskActionRef,
    personalTaskActionPinned,
    titleRef,
    descriptionWidget,
    descriptionOverflowing,
    descriptionId,
    repeatedDescriptionHeading,
    descriptionCanExpand,
    propertiesTriggerRef,
    propertiesExpanded,
    setPropertiesExpanded,
    propertiesId,
    beginContentEditing,
    editItemId,
    allAttachments,
    visibleAttachments,
    effectiveTasks,
    availableCollaborators,
    parentOptions,
    childItems,
    displayedTasks,
    executionChildItems,
    executionTaskCount,
    hasExecutionDetails,
    executionElapsedMinutes,
    executionElapsedLabel,
    hasDraftContent,
    pendingAttachmentRows,
    readPendingAttachment,
    childRailExpanded,
    executionRailExpanded,
    deliveryRailExpanded,
    visibleRailChildren,
    visibleRailTasks,
    visibleRailDeliveries,
    toggleRailSection,
    statusLabel,
    parentItem,
    assigneeName,
    canAssign,
    commentActions,
    canManageIssueSecurity,
    assigneeChanged,
    creator,
    createTitle,
    submitCreate,
    persistAssignee,
    saveDetails,
    cancelContentEditing,
    addCollaborator,
    removeCollaborator,
    handleKeyDown,
    handleDrop,
  }
}
export type IssueDetailModel = ReturnType<typeof useSharedIssueDetailModel>
