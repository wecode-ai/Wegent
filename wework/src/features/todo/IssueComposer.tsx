import { useContext, useEffect, useRef, useState } from 'react'
import { ArrowUp, Bot, LayoutDashboard, Maximize2, Minimize2, Paperclip, X } from 'lucide-react'
import type { CloudProject } from '@/api/deliveries'
import { type ProjectChatControls, type ProjectWorkControls } from '@/components/chat/ChatInput'
import { AttachmentBadges } from '@/components/chat/composer/AttachmentBadges'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { WorkbenchHarnessSelector } from '@/components/layout/WorkbenchHarnessSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { releaseAttachmentPreview } from '@/lib/attachments'
import { cn } from '@/lib/utils'
import type { Attachment, ProjectWithTasks } from '@/types/api'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { ConnectedIssueProjectWork } from './ConnectedIssueProjectWork'
import { WorkItemComposerGuide } from './WorkItemComposerGuide'
import { issueDraftFromText } from './issueComposerDraft'

interface IssueComposerProps {
  projects: CloudProject[]
  initialBoardKey: string
  initialStartExecution?: boolean
  initialContent?: string
  localProjects?: ProjectWithTasks[]
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
    localProjectId: number | null
  }) => Promise<boolean | void> | boolean | void
}

interface StagedIssueAttachment {
  attachment: Attachment
  file: File
}

interface IssueComposerDraft {
  boardKey: string
  content: string
  creationMode: 'issue' | 'task'
  localProjectId: number | null
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
      content: parsed.content,
      creationMode: parsed.creationMode,
      localProjectId: typeof parsed.localProjectId === 'number' ? parsed.localProjectId : null,
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
  const [content, setContent] = useState(initialContent || draft?.content || '')
  const [fullScreen, setFullScreen] = useState(false)
  const [creationMode, setCreationMode] = useState<'issue' | 'task'>(
    draft?.creationMode ?? initialMode
  )
  const [localProjectId, setLocalProjectId] = useState<number | null>(
    draft?.localProjectId ?? initialLocalProjectId ?? localProjects[0]?.id ?? null
  )
  const [localDeviceWorkspaceId, setLocalDeviceWorkspaceId] = useState<number | null>(null)
  const selectedLocalProject = localProjects.find(project => project.id === localProjectId) ?? null
  const selectLocalProject = (projectId: number | null) => {
    setLocalProjectId(projectId)
    setLocalDeviceWorkspaceId(null)
  }
  const selectLocalProjectWorkspace = (projectId: number, deviceWorkspaceId: number | null) => {
    setLocalProjectId(projectId)
    setLocalDeviceWorkspaceId(deviceWorkspaceId)
  }
  const selectedWorkItemProject =
    projects.find(project => `${project.project_store}:${String(project.id)}` === boardKey) ??
    projects[0] ??
    null
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

  useEffect(() => {
    stagedAttachmentsRef.current = stagedAttachments
  }, [stagedAttachments])

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (fullScreen) {
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

  const hasDraft = Boolean(content.trim()) || stagedAttachments.length > 0

  useEffect(() => {
    if (!hasDraft) {
      localStorage.removeItem(draftKey)
      issueDraftAttachmentStore.delete(draftKey)
      return
    }
    const snapshot: IssueComposerDraft = {
      boardKey,
      content,
      creationMode,
      localProjectId,
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
  }, [boardKey, content, creationMode, draftKey, hasDraft, localProjectId, stagedAttachments])

  useEffect(() => {
    if (presentation !== 'popup') return
    const previousFocus = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => {
      const focusTarget = panelRef.current?.querySelector<HTMLElement>(
        '[data-testid="workspace-issue-input"], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
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
    setContent('')
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
  const submit = async (submittedContent?: string) => {
    const description = (submittedContent ?? content).trim()
    const submittedDraft = issueDraftFromText(description)
    if (!boardKey || !submittedDraft.title || busy) return false
    const created = await onCreate({
      boardKey,
      ...submittedDraft,
      files: stagedAttachments.map(item => item.file),
      createTask: creationMode === 'task',
      localProjectId: creationMode === 'task' ? localProjectId : null,
    })
    if (created !== false) {
      localStorage.removeItem(draftKey)
      issueDraftAttachmentStore.delete(draftKey)
    }
    return created
  }
  const fallbackProjectWork: ProjectWorkControls | undefined =
    localProjects.length > 0
      ? {
          projects: localProjects,
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
    <BufferedChatInput
      value={content}
      onChange={setContent}
      onSubmit={submit}
      disabled={busy}
      submitDisabled={busy || !boardKey}
      error={error}
      placeholder={t('workbench.input_placeholder', '随心输入')}
      inputTestId="workspace-issue-input"
      submitButtonTestId="workspace-issue-submit"
      variant="desktop"
      projectChat={projectChat}
      projectWork={resolvedProjectWork}
      showProjectWorkBar={creationMode === 'task' && localProjects.length > 0}
      showExecutionTools={creationMode === 'task'}
      showWorkspaceMenu={false}
      projectWorkBarMiddleContext={
        creationMode === 'task' && selectedWorkItemProject ? (
          <WorkItemComposerGuide
            integrated
            toolbar
            project={selectedWorkItemProject}
            projects={projects}
            onSelectProject={project =>
              setBoardKey(`${project.project_store}:${String(project.id)}`)
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
        aria-label={
          presentation === 'popup' || fullScreen ? t('todo.new_issue', '新建 Issue') : undefined
        }
        onKeyDown={event => {
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
            <header className="flex h-12 shrink-0 items-center justify-between px-4">
              <span className="text-sm font-medium text-text-primary">
                {t('todo.new_issue', '新建 Issue')}
              </span>
              <div
                data-testid="workspace-issue-header-actions"
                className="ml-auto flex items-center gap-1"
              >
                <button
                  type="button"
                  data-testid="workspace-issue-collapse"
                  onClick={() => setFullScreen(false)}
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
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                event.preventDefault()
                stageFiles(Array.from(event.dataTransfer.files))
              }}
            >
              <textarea
                autoFocus
                data-testid="workspace-issue-description"
                value={content}
                disabled={busy}
                onChange={event => setContent(event.target.value)}
                onPaste={event => {
                  const files = Array.from(event.clipboardData.files)
                  if (!files.length) return
                  event.preventDefault()
                  stageFiles(files)
                }}
                placeholder={t('todo.issue_content_placeholder', '填写 Issue 内容…')}
                className="min-h-0 w-full flex-1 resize-none bg-transparent py-2 text-chat leading-6 text-text-primary outline-none placeholder:text-text-muted"
              />
              <AttachmentBadges
                attachments={stagedAttachments.map(item => item.attachment)}
                uploadingFiles={new Map()}
                errors={new Map()}
                onRemoveAttachment={removeAttachment}
              />
              {error ? (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <footer className="mt-4 flex shrink-0 items-center justify-between border-t border-border pt-4">
                <div className="flex items-center gap-2">
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
                    className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
                  >
                    <Paperclip className="h-4 w-4" />
                    {t('todo.add_attachment', '添加附件')}
                  </button>
                  <span className="text-xs text-text-muted">
                    {t('todo.issue_drop_files_hint', '支持拖拽、粘贴图片或文件')}
                  </span>
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
                </div>
                <button
                  type="button"
                  data-testid="workspace-issue-fullscreen-submit"
                  disabled={busy || !boardKey || !issueDraftFromText(content).title}
                  onClick={() => void submit()}
                  className="flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? t('todo.creating', '创建中…') : t('todo.create_issue', '创建 Issue')}
                  <ArrowUp className="h-4 w-4" />
                </button>
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
                  className="text-xl font-normal leading-9 tracking-normal text-text-primary/95"
                >
                  {creationMode === 'issue'
                    ? t('todo.issue_composer_title', '要推进什么？')
                    : t('todo.issue_task_composer_title', '要执行什么？')}
                </h1>
                <p className="mt-2 max-w-[520px] text-sm leading-5 text-text-muted">
                  {creationMode === 'issue'
                    ? t(
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
                      {t('todo.new_issue', '新建 Issue')}
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
            <div className="mb-3 flex items-center gap-2">
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
                  {t('todo.create_issue_tab', '创建 Issue')}
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
                  {t('todo.create_task_tab', '创建任务')}
                </button>
              </div>
              {creationMode === 'issue' ? (
                <button
                  type="button"
                  data-testid="workspace-issue-expand"
                  onClick={() => setFullScreen(true)}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary md:h-8 md:w-8"
                  aria-label={t('todo.expand_issue_editor', '全屏编辑')}
                >
                  <Maximize2 className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <div className="mb-2 flex items-center px-1 text-xs text-text-muted">
              <span className="flex min-w-0 items-center gap-1.5">
                <LayoutDashboard className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {selectedWorkItemProject?.name ??
                    t('workbench.default_work_item_board', '我的任务')}
                </span>
              </span>
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
