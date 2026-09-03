import { type MouseEvent, useContext, useEffect, useRef, useState } from 'react'
import {
  Bot,
  ChevronDown,
  Check,
  CircleUserRound,
  Flag,
  Folder,
  LayoutDashboard,
  Maximize2,
  Minimize2,
  Paperclip,
  Tag,
  X,
} from 'lucide-react'
import {
  isDefaultWorkItemProject,
  type CloudLoopItem,
  type CloudProject,
  type CloudProjectMember,
} from '@/api/deliveries'
import { type ProjectChatControls, type ProjectWorkControls } from '@/components/chat/ChatInput'
import { AttachmentBadges } from '@/components/chat/composer/AttachmentBadges'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { WorkbenchHarnessSelector } from '@/components/layout/WorkbenchHarnessSelector'
import { Tooltip } from '@/components/ui/tooltip'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { releaseAttachmentPreview } from '@/lib/attachments'
import { resolveRuntimeTaskProjects } from '@/lib/runtime-project'
import { resolveRuntimeTaskWorkspaceBinding } from '@/lib/runtime-task-workspace-binding'
import { cn } from '@/lib/utils'
import type { Attachment, ProjectWithTasks, RuntimeTaskCreateRequest } from '@/types/api'
import { ConnectedIssueProjectWork } from './ConnectedIssueProjectWork'
import { WorkItemComposerGuide } from './WorkItemComposerGuide'
import { issueDraftFromText } from './issueComposerDraft'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'

interface IssueComposerProps {
  projects: CloudProject[]
  initialBoardKey: string
  initialStartExecution?: boolean
  initialContent?: string
  localProjects?: ProjectWithTasks[]
  projectMembers?: Record<string, CloudProjectMember[]>
  initialLocalProjectId?: number | null
  presentation?: 'page' | 'popup'
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onCreate: (input: {
    boardKey: string
    title: string
    description: string
    files: File[]
    createTask: boolean
    taskRequest?: RuntimeTaskCreateRequest
    continueCreating?: boolean
    status?: CloudLoopItem['status']
    priority?: CloudLoopItem['priority']
    tags?: string[]
    assigneeUserId?: number | null
  }) => Promise<boolean | void> | boolean | void
}

interface StagedIssueAttachment {
  attachment: Attachment
  file: File
}

interface IssueComposerDraft {
  boardKey: string
  title: string
  content: string
  creationMode: 'issue' | 'task'
  localProjectId: number | null
  status: CloudLoopItem['status']
  priority: CloudLoopItem['priority']
  tags: string[]
  assigneeUserId: number | null
}

const issueDraftAttachmentStore = new Map<string, File[]>()

function issueComposerDraftKey(
  boardKey: string,
  initialMode: IssueComposerDraft['creationMode']
): string {
  return `wework-issue-composer-draft:${boardKey}:${initialMode}`
}

function readIssueComposerDraft(key: string): IssueComposerDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {
      issueDraftAttachmentStore.delete(key)
      return null
    }
    const parsed = JSON.parse(raw) as Partial<IssueComposerDraft>
    if (
      typeof parsed.boardKey !== 'string' ||
      typeof parsed.content !== 'string' ||
      (parsed.creationMode !== 'issue' && parsed.creationMode !== 'task')
    ) {
      return null
    }
    return {
      boardKey: parsed.boardKey,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      content: parsed.content,
      creationMode: parsed.creationMode,
      localProjectId: typeof parsed.localProjectId === 'number' ? parsed.localProjectId : null,
      status:
        typeof parsed.status === 'string' ? (parsed.status as CloudLoopItem['status']) : 'inbox',
      priority:
        parsed.priority === 'low' ||
        parsed.priority === 'medium' ||
        parsed.priority === 'high' ||
        parsed.priority === 'urgent'
          ? parsed.priority
          : 'none',
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      assigneeUserId: typeof parsed.assigneeUserId === 'number' ? parsed.assigneeUserId : null,
    }
  } catch {
    return null
  }
}

function attachmentFromFile(file: File, id: number): Attachment {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : ''
  return {
    id,
    filename: file.name,
    file_size: file.size,
    mime_type: file.type || 'application/octet-stream',
    status: 'ready',
    file_extension: extension,
    created_at: new Date().toISOString(),
    ...(file.type.startsWith('image/') &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
      ? { local_preview_url: URL.createObjectURL(file) }
      : {}),
  }
}

export function IssueComposer({
  projects,
  initialBoardKey,
  initialStartExecution = false,
  initialContent = '',
  localProjects = [],
  projectMembers = {},
  initialLocalProjectId = null,
  presentation = 'page',
  busy = false,
  error,
  onCancel,
  onCreate,
}: IssueComposerProps) {
  const { t } = useTranslation()
  const workbench = useContext(WorkbenchPaneContext)
  const initialMode = initialStartExecution ? 'task' : 'issue'
  const draftKey = issueComposerDraftKey(initialBoardKey, initialMode)
  const [draft] = useState(() => (initialContent.trim() ? null : readIssueComposerDraft(draftKey)))
  const [restoredFiles] = useState(() =>
    draft ? (issueDraftAttachmentStore.get(draftKey) ?? []) : []
  )
  const [boardKey, setBoardKey] = useState(draft?.boardKey ?? initialBoardKey)
  const [title, setTitle] = useState(draft?.title ?? '')
  const [content, setContent] = useState(initialContent || draft?.content || '')
  const contentRef = useRef(initialContent || draft?.content || '')
  const [fullScreen, setFullScreen] = useState(false)
  const fullScreenRef = useRef(false)
  const [continueCreating, setContinueCreating] = useState(false)
  const [status, setStatus] = useState<CloudLoopItem['status']>(draft?.status ?? 'inbox')
  const [priority, setPriority] = useState<CloudLoopItem['priority']>(draft?.priority ?? 'none')
  const [tags, setTags] = useState<string[]>(draft?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState<number | null>(draft?.assigneeUserId ?? null)
  const [creationMode, setCreationMode] = useState<'issue' | 'task'>(
    draft?.creationMode ?? initialMode
  )
  const projectRuntimeWork = workbench?.state?.runtimeWork ?? {
    projects: localProjects.map(project => ({
      project: {
        key: `local-project-${project.id}`,
        id: project.id,
        name: project.name,
        description: project.description,
        kind: 'local',
        source: 'local_project',
      },
      deviceWorkspaces: [],
      totalTasks: project.tasks?.length ?? 0,
    })),
    chats: [],
    totalTasks: 0,
  }
  const runtimeTaskProjects = resolveRuntimeTaskProjects(localProjects, projectRuntimeWork)
  const [localProjectId, setLocalProjectId] = useState<number | null>(
    draft?.localProjectId ?? initialLocalProjectId ?? runtimeTaskProjects[0]?.id ?? null
  )
  const [localDeviceWorkspaceId, setLocalDeviceWorkspaceId] = useState<number | null>(null)
  const [executionMode, setExecutionMode] = useState(
    () => workbench?.projectExecutionMode ?? 'current_workspace'
  )
  const [worktreeBranch, setWorktreeBranch] = useState<string | null>(
    () => workbench?.projectWorktreeBranch ?? null
  )
  const selectedLocalProject =
    runtimeTaskProjects.find(project => project.id === localProjectId) ?? null
  const selectedWorkspaceBinding = resolveRuntimeTaskWorkspaceBinding({
    runtimeWork: projectRuntimeWork,
    projectUiId: localProjectId,
    deviceWorkspaceId: localDeviceWorkspaceId,
  })
  const selectLocalProject = (projectId: number | null) => {
    setLocalProjectId(projectId)
    setLocalDeviceWorkspaceId(null)
  }
  const selectLocalProjectWorkspace = (projectId: number, deviceWorkspaceId: number | null) => {
    setLocalProjectId(projectId)
    setLocalDeviceWorkspaceId(deviceWorkspaceId)
  }
  const selectBoard = (nextBoardKey: string) => {
    if (nextBoardKey === boardKey) return
    setBoardKey(nextBoardKey)
    setStatus('inbox')
    setAssigneeUserId(null)
  }
  const selectedWorkItemProject =
    projects.find(project => `${project.project_store}:${String(project.id)}` === boardKey) ??
    projects[0] ??
    null
  const isPersonalTaskBoard = isDefaultWorkItemProject(selectedWorkItemProject)
  const newLightweightItemLabel = isPersonalTaskBoard
    ? t('todo.new_task', '新建任务')
    : t('todo.new_issue', '新建 Issue')
  const createLightweightItemLabel = isPersonalTaskBoard
    ? t('todo.add_task', '添加任务')
    : t('todo.create_issue', '创建 Issue')
  const selectedProjectMembers = projectMembers[boardKey] ?? []
  const selectedAssigneeName =
    selectedProjectMembers.find(member => member.user_id === assigneeUserId)?.user_name ?? null
  const statusOptions = selectedWorkItemProject?.board_config?.statuses ?? [
    { id: 'inbox', name: t('todo.status_inbox', '收集箱') },
    { id: 'pending', name: t('todo.status_pending', '待处理') },
    { id: 'in_progress', name: t('todo.status_in_progress', '进行中') },
  ]
  const [stagedAttachments, setStagedAttachments] = useState<StagedIssueAttachment[]>(() =>
    restoredFiles.map((file, index) => ({
      attachment: attachmentFromFile(file, -(index + 1)),
      file,
    }))
  )
  const stagedAttachmentsRef = useRef(stagedAttachments)
  const nextAttachmentId = useRef(-(restoredFiles.length + 1))
  const panelRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    stagedAttachmentsRef.current = stagedAttachments
  }, [stagedAttachments])

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (fullScreen) {
        fullScreenRef.current = false
        setFullScreen(false)
        return
      }
      onCancel()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [fullScreen, onCancel])

  useEffect(
    () => () => {
      stagedAttachmentsRef.current.forEach(item => releaseAttachmentPreview(item.attachment))
    },
    []
  )

  const hasDraft =
    Boolean(title.trim() || content.trim() || tags.length || assigneeUserId) ||
    status !== 'inbox' ||
    priority !== 'none' ||
    stagedAttachments.length > 0

  useEffect(() => {
    if (!hasDraft) {
      localStorage.removeItem(draftKey)
      issueDraftAttachmentStore.delete(draftKey)
      return
    }
    const snapshot: IssueComposerDraft = {
      boardKey,
      title,
      content,
      creationMode,
      localProjectId,
      status,
      priority,
      tags,
      assigneeUserId,
    }
    localStorage.setItem(draftKey, JSON.stringify(snapshot))
    if (stagedAttachments.length > 0) {
      issueDraftAttachmentStore.set(
        draftKey,
        stagedAttachments.map(item => item.file)
      )
    } else {
      issueDraftAttachmentStore.delete(draftKey)
    }
  }, [
    boardKey,
    content,
    creationMode,
    draftKey,
    hasDraft,
    localProjectId,
    priority,
    stagedAttachments,
    status,
    tags,
    title,
    assigneeUserId,
  ])

  useEffect(() => {
    if (presentation !== 'popup') return
    const previousFocus = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => {
      const focusTarget = panelRef.current?.querySelector<HTMLElement>(
        '[data-testid="workspace-issue-input"]'
      )
      focusTarget?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [presentation])

  const stageFiles = (files: File | File[]) => {
    const selectedFiles = Array.isArray(files) ? files : [files]
    setStagedAttachments(current => [
      ...current,
      ...selectedFiles.map(file => {
        const id = nextAttachmentId.current
        nextAttachmentId.current -= 1
        return { attachment: attachmentFromFile(file, id), file }
      }),
    ])
  }
  const removeAttachment = (attachmentId: number) => {
    setStagedAttachments(current =>
      current.filter(item => {
        if (item.attachment.id !== attachmentId) return true
        releaseAttachmentPreview(item.attachment)
        return false
      })
    )
  }
  const clearDraft = () => {
    stagedAttachments.forEach(item => releaseAttachmentPreview(item.attachment))
    localStorage.removeItem(draftKey)
    issueDraftAttachmentStore.delete(draftKey)
    setTitle('')
    contentRef.current = ''
    setContent('')
    setStatus('inbox')
    setPriority('none')
    setTags([])
    setTagDraft('')
    setAssigneeUserId(null)
    setStagedAttachments([])
  }
  const projectChat: ProjectChatControls = {
    ...(workbench?.projectChat ?? {
      models: [],
      skills: [],
      selectedModel: null,
      selectedModelOptions: {},
      selectedSkills: [],
      isOptionsLocked: false,
      setSelectedModel: () => undefined,
      setSelectedModelOption: () => undefined,
      toggleSkill: () => undefined,
      listLocalSkills: async () => [],
    }),
    scopeKey: `issue-composer:${boardKey}`,
    attachments: stagedAttachments.map(item => item.attachment),
    uploadingFiles: new Map(),
    errors: new Map(),
    handleFileSelect: async files => stageFiles(files),
    removeAttachment: async attachmentId => removeAttachment(attachmentId),
  }
  const createIssue = async (
    submittedContent: string,
    submittedTitle?: string,
    keepOpen = false
  ) => {
    const description = submittedContent.trim()
    const pendingTag = tagDraft.trim().replace(/^#/, '')
    const submittedTags = pendingTag && !tags.includes(pendingTag) ? [...tags, pendingTag] : tags
    const derivedDraft = issueDraftFromText(description)
    const submittedDraft = {
      title:
        creationMode === 'issue'
          ? (submittedTitle ?? title).trim() || derivedDraft.title
          : derivedDraft.title,
      description,
    }
    if (!boardKey || !submittedDraft.title || busy) return false
    const selectedModel = projectChat.getSelectedModel?.() ?? projectChat.selectedModel
    const selectedModelOptions =
      projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
    const executionModel = selectedModelExecutionFields(selectedModel, selectedModelOptions)
    const created = await onCreate({
      boardKey,
      ...submittedDraft,
      files: stagedAttachments.map(item => item.file),
      createTask: creationMode === 'task',
      ...(creationMode === 'task'
        ? {
            taskRequest: {
              schemaVersion: 2,
              runtime: 'codex',
              message: description,
              ...(selectedWorkspaceBinding ?? {}),
              ...(executionMode === 'git_worktree'
                ? {
                    execution: {
                      workspace: {
                        source: 'git_worktree' as const,
                        ...(worktreeBranch?.trim() ? { branch: worktreeBranch.trim() } : {}),
                      },
                    },
                  }
                : {}),
              ...executionModel,
              modelSelection:
                selectedModel && executionModel.modelId
                  ? {
                      modelName: executionModel.modelId,
                      modelType: executionModel.modelType ?? selectedModel.type,
                      options: executionModel.modelOptions ?? {},
                    }
                  : null,
              additionalSkills: projectChat.selectedSkills,
            },
          }
        : {}),
      ...(keepOpen ? { continueCreating: true } : {}),
      ...(status !== 'inbox' ? { status } : {}),
      ...(priority !== 'none' ? { priority } : {}),
      ...(submittedTags.length ? { tags: submittedTags } : {}),
      ...(assigneeUserId ? { assigneeUserId } : {}),
    })
    if (created !== false) {
      localStorage.removeItem(draftKey)
      issueDraftAttachmentStore.delete(draftKey)
      if (keepOpen) {
        stagedAttachments.forEach(item => releaseAttachmentPreview(item.attachment))
        setTitle('')
        contentRef.current = ''
        setContent('')
        setTags(submittedTags)
        setTagDraft('')
        setStagedAttachments([])
        window.requestAnimationFrame(() => titleInputRef.current?.focus())
      }
    }
    return created
  }
  const submit = (submittedContent?: string) =>
    createIssue(submittedContent ?? contentRef.current, title)
  const updateCompactContent = (value: string) => {
    if (fullScreenRef.current) return
    contentRef.current = value
    setContent(value)
  }
  const updateDescription = (value: string) => {
    contentRef.current = value
    setContent(value)
  }
  const applyIssueTemplate = (event: MouseEvent<HTMLButtonElement>) => {
    const value = event.currentTarget.dataset.templateContent ?? ''
    contentRef.current = value
    setContent(value)
    window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-testid="workspace-issue-input"]')?.focus()
    })
  }
  const commitTagDraft = () => {
    const nextTag = tagDraft.trim().replace(/^#/, '')
    if (nextTag && !tags.includes(nextTag)) setTags(current => [...current, nextTag])
    setTagDraft('')
  }
  const openFullScreen = () => {
    const compactInput = panelRef.current?.querySelector<HTMLElement>(
      '[data-testid="workspace-issue-input"]'
    )
    const renderedContent =
      compactInput instanceof HTMLTextAreaElement
        ? compactInput.value
        : (compactInput?.innerText ?? compactInput?.textContent ?? '')
    const normalizedRenderedContent = renderedContent.endsWith('\n')
      ? renderedContent.slice(0, -1)
      : renderedContent
    const latestContent = normalizedRenderedContent.trim()
      ? normalizedRenderedContent
      : contentRef.current
    contentRef.current = latestContent
    setContent(latestContent)
    setTitle(currentTitle => currentTitle.trim() || issueDraftFromText(latestContent).title)
    fullScreenRef.current = true
    setFullScreen(true)
  }
  const closeFullScreen = () => {
    fullScreenRef.current = false
    setFullScreen(false)
  }
  const fallbackProjectWork: ProjectWorkControls | undefined =
    runtimeTaskProjects.length > 0
      ? {
          projects: runtimeTaskProjects,
          devices: [],
          runtimeWork: projectRuntimeWork,
          currentProject: selectedLocalProject,
          currentProjectId: selectedLocalProject?.id,
          selectedDeviceWorkspaceId: localDeviceWorkspaceId,
          executionMode: 'current_workspace',
          onSelectProject: selectLocalProject,
          onSelectStandaloneDevice: () => undefined,
          onSelectProjectWorkspace: selectLocalProjectWorkspace,
          onExecutionModeChange: () => undefined,
          showProjectClearButton: false,
        }
      : undefined
  const renderComposer = (resolvedProjectWork: ProjectWorkControls | undefined) => (
    <div
      data-testid="workspace-issue-composer-input-shell"
      className="relative font-normal text-text-primary"
    >
      <BufferedChatInput
        value={content}
        onChange={updateCompactContent}
        onSubmit={submit}
        disabled={busy}
        submitDisabled={busy || !boardKey}
        error={error}
        placeholder={t('workbench.input_placeholder', '随心输入')}
        inputTestId="workspace-issue-input"
        nativeEmptyCaret
        submitButtonTestId="workspace-issue-submit"
        variant="desktop"
        projectChat={projectChat}
        projectWork={
          resolvedProjectWork
            ? {
                ...resolvedProjectWork,
                executionMode,
                worktreeBranch,
                onExecutionModeChange: setExecutionMode,
                onWorktreeBranchChange: setWorktreeBranch,
              }
            : undefined
        }
        showProjectWorkBar={creationMode === 'task' && runtimeTaskProjects.length > 0}
        showExecutionTools={creationMode === 'task'}
        showWorkspaceMenu={false}
        toolbarLeadingContext={
          creationMode === 'issue' ? (
            <label className="relative flex h-8 min-w-0 max-w-48 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm font-normal leading-[18px] text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-within:bg-muted focus-within:text-text-primary">
              <LayoutDashboard className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">
                {selectedWorkItemProject?.name ??
                  t('workbench.default_work_item_board', '我的任务')}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
              <select
                data-testid="workspace-issue-project-compact"
                aria-label={t('todo.issue_project_label', '项目空间')}
                value={boardKey}
                disabled={busy || projects.length === 0}
                onChange={event => selectBoard(event.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              >
                {!projects.some(
                  project => `${project.project_store}:${String(project.id)}` === boardKey
                ) && boardKey ? (
                  <option value={boardKey}>
                    {selectedWorkItemProject?.name ??
                      t('workbench.default_work_item_board', '我的任务')}
                  </option>
                ) : null}
                {projects.map(project => (
                  <option
                    key={`${project.project_store}:${String(project.id)}`}
                    value={`${project.project_store}:${String(project.id)}`}
                  >
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
        projectWorkBarMiddleContext={
          creationMode === 'task' && selectedWorkItemProject ? (
            <WorkItemComposerGuide
              integrated
              toolbar
              project={selectedWorkItemProject}
              projects={projects}
              onSelectProject={project =>
                selectBoard(`${project.project_store}:${String(project.id)}`)
              }
            />
          ) : undefined
        }
        projectWorkBarTrailingContext={
          creationMode === 'task' ? (
            <WorkbenchHarnessSelector
              runtime="codex"
              harnesses={[]}
              enabledHarnesses={[]}
              loading={false}
              detectionFailed={false}
              onRuntimeChange={() => undefined}
            />
          ) : undefined
        }
      />
      {creationMode === 'issue' ? (
        <Tooltip
          label={t('todo.expand_issue_editor', '全屏编辑')}
          side="top"
          align="end"
          className="absolute right-3 top-3 z-10"
        >
          <button
            type="button"
            data-testid="workspace-issue-expand"
            onClick={openFullScreen}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-muted hover:text-text-primary focus-visible:bg-muted focus-visible:text-text-primary focus-visible:outline-none md:h-8 md:w-8"
            aria-label={t('todo.expand_issue_editor', '全屏编辑')}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </Tooltip>
      ) : null}
      {creationMode === 'issue' && !content.trim() ? (
        <div
          data-testid="workspace-issue-templates"
          className="mt-2 flex flex-wrap items-center gap-1.5 px-1"
        >
          <span className="mr-1 text-xs text-text-muted">
            {t('todo.issue_templates_label', '从模板开始')}
          </span>
          {[
            {
              key: 'feature',
              label: t('todo.issue_template_feature', '开发功能'),
              content: t(
                'todo.issue_template_feature_content',
                '目标：\n\n背景：\n\n范围：\n\n验收标准：\n'
              ),
            },
            {
              key: 'bug',
              label: t('todo.issue_template_bug', '修复问题'),
              content: t(
                'todo.issue_template_bug_content',
                '问题现象：\n\n复现步骤：\n\n期望结果：\n'
              ),
            },
            {
              key: 'research',
              label: t('todo.issue_template_research', '调研方案'),
              content: t(
                'todo.issue_template_research_content',
                '待回答问题：\n\n输出要求：\n\n决策标准：\n'
              ),
            },
          ].map(template => (
            <button
              key={template.key}
              type="button"
              data-testid={`workspace-issue-template-${template.key}`}
              data-template-content={template.content}
              disabled={busy}
              onClick={applyIssueTemplate}
              className="h-7 rounded-lg bg-muted px-2.5 text-xs text-text-secondary transition hover:bg-text-primary/10 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-40"
            >
              {template.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <div
      data-testid="workspace-issue-composer"
      onClick={event => {
        if (presentation === 'popup' && !fullScreen && event.target === event.currentTarget) {
          onCancel()
        }
      }}
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10',
        presentation === 'popup' &&
          !fullScreen &&
          'fixed inset-0 z-modal bg-black/30 px-6 py-10 backdrop-blur-[2px]',
        fullScreen && 'overflow-hidden'
      )}
    >
      <section
        ref={panelRef}
        data-testid="workspace-issue-composer-panel"
        role={presentation === 'popup' || fullScreen ? 'dialog' : undefined}
        aria-modal={presentation === 'popup' || fullScreen ? 'true' : undefined}
        aria-label={presentation === 'popup' || fullScreen ? newLightweightItemLabel : undefined}
        onKeyDown={event => {
          if (
            fullScreen &&
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !busy &&
            boardKey &&
            title.trim()
          ) {
            event.preventDefault()
            void createIssue(content, title, continueCreating)
            return
          }
          if (event.defaultPrevented) return
          if ((presentation !== 'popup' && !fullScreen) || event.key !== 'Tab') return
          const focusable = Array.from(
            panelRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
            ) ?? []
          )
          if (focusable.length === 0) return
          const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
          const nextIndex = event.shiftKey
            ? currentIndex <= 0
              ? focusable.length - 1
              : currentIndex - 1
            : currentIndex === focusable.length - 1
              ? 0
              : currentIndex + 1
          event.preventDefault()
          focusable[nextIndex]?.focus()
        }}
        className={cn(
          'w-full max-w-[736px]',
          presentation === 'popup' &&
            !fullScreen &&
            'max-h-full overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl',
          fullScreen &&
            'fixed bottom-4 left-4 right-4 top-[54px] z-modal flex w-auto max-h-none max-w-none flex-col overflow-hidden rounded-2xl border border-border bg-background p-0 shadow-xl'
        )}
      >
        {fullScreen ? (
          <>
            <header className="flex h-12 shrink-0 items-center px-4">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {selectedWorkItemProject?.name ??
                    t('workbench.default_work_item_board', '我的任务')}{' '}
                  · {newLightweightItemLabel}
                </span>
              </span>
              <div
                data-testid="workspace-issue-header-actions"
                className="ml-auto flex items-center gap-1"
              >
                <button
                  type="button"
                  data-testid="workspace-issue-collapse"
                  onClick={closeFullScreen}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary md:h-8 md:w-8"
                  aria-label={t('todo.collapse_issue_editor', '收起编辑器')}
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  data-testid="workspace-issue-close"
                  onClick={onCancel}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary md:h-8 md:w-8"
                  aria-label={t('common.close', '关闭')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </header>
            <div
              data-testid="workspace-issue-editor-body"
              className="flex min-h-0 w-full flex-1 flex-col px-6 py-4"
              onDragOver={event => {
                if (event.dataTransfer.types.includes('Files')) event.preventDefault()
              }}
              onDropCapture={event => {
                const files = Array.from(event.dataTransfer.files)
                if (!files.length) return
                event.preventDefault()
                event.stopPropagation()
                stageFiles(files)
              }}
            >
              <div className="min-h-0 flex-1 overflow-y-auto">
                <main className="mx-auto flex min-h-full w-full max-w-[860px] flex-col pb-6 pt-6">
                  <input
                    ref={titleInputRef}
                    autoFocus
                    maxLength={255}
                    data-testid="workspace-issue-title"
                    aria-label={t('todo.issue_title_label', '标题')}
                    value={title}
                    disabled={busy}
                    onChange={event => setTitle(event.target.value)}
                    placeholder={t('todo.issue_title_placeholder', 'Issue 标题')}
                    className="block h-11 w-full border-0 bg-transparent text-heading-md font-medium leading-8 tracking-normal text-text-primary outline-none placeholder:text-text-muted/55 disabled:opacity-60"
                  />

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
                      <Folder className="h-4 w-4 shrink-0 text-text-muted" />
                      <span className="max-w-48 truncate font-medium text-text-primary">
                        {selectedWorkItemProject?.name ??
                          t('workbench.default_work_item_board', '我的任务')}
                      </span>
                      <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
                      <select
                        data-testid="workspace-issue-project"
                        aria-label={t('todo.issue_project_label', '项目空间')}
                        value={boardKey}
                        disabled={busy || projects.length === 0}
                        onChange={event => selectBoard(event.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                      >
                        {!projects.some(
                          project => `${project.project_store}:${String(project.id)}` === boardKey
                        ) && boardKey ? (
                          <option value={boardKey}>
                            {selectedWorkItemProject?.name ??
                              t('workbench.default_work_item_board', '我的任务')}
                          </option>
                        ) : null}
                        {projects.map(project => (
                          <option
                            key={`${project.project_store}:${String(project.id)}`}
                            value={`${project.project_store}:${String(project.id)}`}
                          >
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
                      <span className="h-2 w-2 rounded-full bg-zinc-400" />
                      <span className="font-medium text-text-primary">
                        {statusOptions.find(option => option.id === status)?.name ?? status}
                      </span>
                      <ChevronDown className="h-3 w-3 text-text-muted" />
                      <select
                        data-testid="workspace-issue-status"
                        aria-label={t('todo.status', '状态')}
                        value={status}
                        disabled={busy}
                        onChange={event => setStatus(event.target.value as CloudLoopItem['status'])}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      >
                        {statusOptions.map(option => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
                      <Flag className="h-3.5 w-3.5 text-text-muted" />
                      <span className="font-medium text-text-primary">
                        {priority === 'none'
                          ? t('todo.priority_none', '无优先级')
                          : priority === 'low'
                            ? t('todo.priority_low', '低')
                            : priority === 'medium'
                              ? t('todo.priority_medium', '普通')
                              : priority === 'high'
                                ? t('todo.priority_high', '高')
                                : t('todo.priority_urgent', '紧急')}
                      </span>
                      <ChevronDown className="h-3 w-3 text-text-muted" />
                      <select
                        data-testid="workspace-issue-priority"
                        aria-label={t('todo.priority', '优先级')}
                        value={priority}
                        disabled={busy}
                        onChange={event =>
                          setPriority(event.target.value as CloudLoopItem['priority'])
                        }
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      >
                        <option value="none">{t('todo.priority_none', '无优先级')}</option>
                        <option value="low">{t('todo.priority_low', '低')}</option>
                        <option value="medium">{t('todo.priority_medium', '普通')}</option>
                        <option value="high">{t('todo.priority_high', '高')}</option>
                        <option value="urgent">{t('todo.priority_urgent', '紧急')}</option>
                      </select>
                    </label>
                    <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
                      <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
                      <span className="max-w-32 truncate font-medium text-text-primary">
                        {selectedAssigneeName ?? t('todo.unassigned', '未指派')}
                      </span>
                      <ChevronDown className="h-3 w-3 text-text-muted" />
                      <select
                        data-testid="workspace-issue-assignee"
                        aria-label={t('todo.assignee', '负责人')}
                        value={assigneeUserId ?? ''}
                        disabled={busy || selectedProjectMembers.length === 0}
                        onChange={event => setAssigneeUserId(Number(event.target.value) || null)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                      >
                        <option value="">{t('todo.unassigned', '未指派')}</option>
                        {selectedProjectMembers.map(member => (
                          <option key={member.user_id} value={member.user_id}>
                            {member.user_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {tags.map(tag => (
                      <span
                        key={tag}
                        data-testid={`workspace-issue-tag-${tag}`}
                        className="inline-flex h-8 items-center gap-1 rounded-full border border-border px-3 text-sm font-normal text-text-primary"
                      >
                        # {tag}
                        <button
                          type="button"
                          aria-label={t('todo.remove_tag', '移除标签 {{tag}}', { tag })}
                          onClick={() =>
                            setTags(current => current.filter(candidate => candidate !== tag))
                          }
                          className="flex h-4 w-4 items-center justify-center rounded-full text-text-muted hover:bg-muted hover:text-text-primary"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    <label className="inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-sm font-normal text-text-secondary focus-within:bg-muted">
                      <Tag className="h-3.5 w-3.5 text-text-muted" />
                      <input
                        data-testid="workspace-issue-tag-input"
                        value={tagDraft}
                        disabled={busy}
                        onChange={event => setTagDraft(event.target.value)}
                        onBlur={commitTagDraft}
                        onKeyDown={event => {
                          if (event.key !== 'Enter' && event.key !== ',') return
                          event.preventDefault()
                          commitTagDraft()
                        }}
                        placeholder={t('todo.add_tag', '添加标签')}
                        className="w-20 bg-transparent outline-none placeholder:text-text-muted"
                      />
                    </label>
                    <input
                      ref={fileInputRef}
                      data-testid="workspace-issue-file-input"
                      type="file"
                      multiple
                      className="hidden"
                      onChange={event => {
                        if (event.target.files) stageFiles(Array.from(event.target.files))
                        event.target.value = ''
                      }}
                    />
                    <button
                      type="button"
                      data-testid="workspace-issue-attach"
                      disabled={busy}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-transparent px-3 text-sm font-normal text-text-secondary transition hover:border-border hover:bg-muted hover:text-text-primary disabled:opacity-50"
                    >
                      <Paperclip className="h-4 w-4" />
                      {stagedAttachments.length > 0
                        ? t('todo.issue_attachment_count', '{{count}} 个附件', {
                            count: stagedAttachments.length,
                          })
                        : t('todo.add_attachment', '添加附件')}
                    </button>
                  </div>

                  <section
                    data-testid="workspace-issue-description-region"
                    className="mt-6 flex min-h-[360px] flex-1 flex-col border-t border-border pt-5"
                  >
                    <TaskDescriptionEditor
                      value={content}
                      onChange={updateDescription}
                      onPasteFiles={stageFiles}
                      disabled={busy}
                      testId="workspace-issue-description"
                      ariaLabel={t('todo.issue_description_label', '描述')}
                      placeholder={t(
                        'todo.issue_description_placeholder',
                        '补充背景、目标、验收标准或其他上下文…'
                      )}
                      className="issue-description-editor min-h-[280px] flex-1"
                    />
                    <AttachmentBadges
                      attachments={stagedAttachments.map(item => item.attachment)}
                      uploadingFiles={new Map()}
                      errors={new Map()}
                      onRemoveAttachment={removeAttachment}
                    />
                    <p className="mt-3 shrink-0 text-xs text-text-muted">
                      {t('todo.issue_markdown_hint', '支持 Markdown，可拖拽或粘贴文件')}
                    </p>
                  </section>
                  {error ? (
                    <p className="mt-4 text-sm text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                </main>
              </div>
              <footer className="shrink-0 border-t border-border pt-3">
                <div className="mx-auto flex w-full max-w-[860px] items-center gap-2">
                  <button
                    type="button"
                    data-testid="workspace-issue-continue-creating"
                    aria-pressed={continueCreating}
                    disabled={busy}
                    onClick={() => setContinueCreating(current => !current)}
                    className={cn(
                      'flex h-8 items-center gap-2 rounded-lg px-2 text-xs transition disabled:opacity-50',
                      continueCreating
                        ? 'bg-muted text-text-primary'
                        : 'text-text-secondary hover:bg-muted hover:text-text-primary'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 items-center justify-center rounded border',
                        continueCreating
                          ? 'border-text-primary bg-text-primary text-background'
                          : 'border-border'
                      )}
                    >
                      {continueCreating ? <Check className="h-3 w-3" /> : null}
                    </span>
                    {t('todo.issue_continue_creating', '创建后继续')}
                  </button>
                  {hasDraft ? (
                    <>
                      <span
                        data-testid="workspace-issue-draft-status"
                        className="text-xs text-text-muted"
                      >
                        {t('todo.issue_draft_saved', '草稿已自动保存')}
                      </span>
                      <button
                        type="button"
                        data-testid="workspace-issue-clear-draft"
                        disabled={busy}
                        onClick={clearDraft}
                        className="h-8 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
                      >
                        {t('todo.clear_issue_draft', '清除草稿')}
                      </button>
                    </>
                  ) : null}
                  <span className="flex-1" />
                  <span className="hidden text-xs text-text-muted sm:inline">
                    {isPersonalTaskBoard
                      ? t('todo.task_create_shortcut', '⌘ Enter 添加任务')
                      : t('todo.issue_create_shortcut', '⌘ Enter 创建 Issue')}
                  </span>
                  <button
                    type="button"
                    data-testid="workspace-issue-fullscreen-submit"
                    disabled={busy || !boardKey || !title.trim()}
                    onClick={() => void createIssue(content, title, continueCreating)}
                    className="flex h-8 items-center gap-2 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                  >
                    {busy ? t('todo.creating', '创建中…') : createLightweightItemLabel}
                    <Check className="h-4 w-4" />
                  </button>
                </div>
              </footer>
            </div>
          </>
        ) : (
          <>
            {presentation === 'page' ? (
              <div className="mb-8 flex flex-col items-center text-center">
                <Bot className="mb-5 h-9 w-9 text-text-muted/55" aria-hidden="true" />
                <h1
                  data-testid="workspace-issue-heading"
                  className="text-heading-md font-medium leading-7 tracking-normal text-text-primary/95"
                >
                  {creationMode === 'issue'
                    ? isPersonalTaskBoard
                      ? t('todo.task_composer_title', '要记录什么？')
                      : t('todo.issue_composer_title', '要推进什么？')
                    : t('todo.issue_task_composer_title', '要执行什么？')}
                </h1>
                <p className="mt-2 max-w-[520px] text-sm leading-5 text-text-muted">
                  {creationMode === 'issue'
                    ? isPersonalTaskBoard
                      ? t(
                          'todo.task_composer_subtitle',
                          '先记录到我的任务，准备好后再推进或开始执行。'
                        )
                      : t(
                          'todo.issue_composer_subtitle',
                          '描述目标、问题或交付，创建后会进入当前项目空间。'
                        )
                    : t(
                        'todo.issue_task_composer_subtitle',
                        '描述需要完成的工作，并选择本地工作空间和执行配置。'
                      )}
                </p>
              </div>
            ) : (
              <div className="mb-5 flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <LayoutDashboard className="h-4 w-4 shrink-0 text-text-muted" />
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-medium text-text-primary">
                      {newLightweightItemLabel}
                    </h2>
                    <p className="truncate text-xs text-text-muted">
                      {selectedWorkItemProject?.name ??
                        t('workbench.default_work_item_board', '我的任务')}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="workspace-issue-close"
                  onClick={onCancel}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary md:h-8 md:w-8"
                  aria-label={t('common.close', '关闭')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            <div className="mb-3">
              <div
                data-testid="workspace-issue-creation-tabs"
                className="inline-flex h-9 items-center rounded-xl bg-muted p-1"
                role="tablist"
                aria-label={t('todo.issue_creation_mode', '创建方式')}
              >
                <button
                  type="button"
                  role="tab"
                  data-testid="workspace-create-issue-tab"
                  aria-selected={creationMode === 'issue'}
                  onClick={() => setCreationMode('issue')}
                  className={cn(
                    'h-7 rounded-lg px-3 text-sm font-medium transition',
                    creationMode === 'issue'
                      ? 'bg-background text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  )}
                >
                  {isPersonalTaskBoard
                    ? t('todo.add_task_tab', '添加任务')
                    : t('todo.create_issue_tab', '创建 Issue')}
                </button>
                <button
                  type="button"
                  role="tab"
                  data-testid="workspace-create-task-tab"
                  aria-selected={creationMode === 'task'}
                  onClick={() => setCreationMode('task')}
                  className={cn(
                    'h-7 rounded-lg px-3 text-sm font-medium transition',
                    creationMode === 'task'
                      ? 'bg-background text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  )}
                >
                  {isPersonalTaskBoard
                    ? t('todo.create_and_run_task_tab', '创建并执行')
                    : t('todo.create_task_tab', '创建任务')}
                </button>
              </div>
              <p
                data-testid="workspace-issue-creation-mode-description"
                className="mt-2 text-xs text-text-muted"
              >
                {creationMode === 'issue'
                  ? isPersonalTaskBoard
                    ? t(
                        'todo.add_task_mode_description',
                        '先加入看板，稍后再补充负责人或启动执行。'
                      )
                    : t(
                        'todo.create_issue_mode_description',
                        'Issue 用于记录一个需要持续推进的目标、问题或交付。'
                      )
                  : t(
                      'todo.create_task_mode_description',
                      '任务会绑定工作空间和执行配置，创建后可立即开始处理。'
                    )}
              </p>
            </div>
            {creationMode === 'task' && workbench?.selectProject && selectedLocalProject ? (
              <ConnectedIssueProjectWork
                project={selectedLocalProject}
                selectedDeviceWorkspaceId={localDeviceWorkspaceId}
                onSelectProject={selectLocalProject}
                onSelectProjectWorkspace={selectLocalProjectWorkspace}
              >
                {renderComposer}
              </ConnectedIssueProjectWork>
            ) : (
              renderComposer(fallbackProjectWork)
            )}
            {hasDraft ? (
              <div className="mt-3 flex items-center justify-end gap-2">
                <span
                  data-testid="workspace-issue-draft-status"
                  className="text-xs text-text-muted"
                >
                  {t('todo.issue_draft_saved', '草稿已自动保存')}
                </span>
                <button
                  type="button"
                  data-testid="workspace-issue-clear-draft"
                  disabled={busy}
                  onClick={clearDraft}
                  className="h-7 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
                >
                  {t('todo.clear_issue_draft', '清除草稿')}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}
