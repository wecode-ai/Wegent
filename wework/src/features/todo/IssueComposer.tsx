import { useContext, useEffect, useRef, useState } from 'react'
import type { CloudProject } from '@/api/deliveries'
import { type ProjectChatControls, type ProjectWorkControls } from '@/components/chat/ChatInput'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { WorkbenchHarnessSelector } from '@/components/layout/WorkbenchHarnessSelector'
import { useTranslation } from '@/hooks/useTranslation'
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
  const [boardKey, setBoardKey] = useState(initialBoardKey)
  const [content, setContent] = useState(initialContent)
  const [creationMode, setCreationMode] = useState<'issue' | 'task'>(
    initialStartExecution ? 'task' : 'issue'
  )
  const [localProjectId, setLocalProjectId] = useState<number | null>(
    initialLocalProjectId ?? localProjects[0]?.id ?? null
  )
  const selectedLocalProject = localProjects.find(project => project.id === localProjectId) ?? null
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
  const [stagedAttachments, setStagedAttachments] = useState<StagedIssueAttachment[]>([])
  const nextAttachmentId = useRef(-1)
  const panelRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onCancel])

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

  const projectChat: ProjectChatControls | undefined = workbench?.projectChat
    ? {
        ...workbench.projectChat,
        scopeKey: `issue-composer:${boardKey}`,
        attachments: stagedAttachments.map(item => item.attachment),
        uploadingFiles: new Map(),
        errors: new Map(),
        handleFileSelect: async files => {
          const selectedFiles = Array.isArray(files) ? files : [files]
          setStagedAttachments(current => [
            ...current,
            ...selectedFiles.map(file => {
              const id = nextAttachmentId.current
              nextAttachmentId.current -= 1
              return { attachment: attachmentFromFile(file, id), file }
            }),
          ])
        },
        removeAttachment: async attachmentId => {
          setStagedAttachments(current =>
            current.filter(item => item.attachment.id !== attachmentId)
          )
        },
      }
    : undefined
  const submit = async (submittedContent?: string) => {
    const submittedDraft = issueDraftFromText(submittedContent ?? content)
    if (!boardKey || !submittedDraft.title || busy) return false
    return onCreate({
      boardKey,
      ...submittedDraft,
      files: stagedAttachments.map(item => item.file),
      createTask: creationMode === 'task',
      localProjectId: creationMode === 'task' ? localProjectId : null,
    })
  }
  const fallbackProjectWork: ProjectWorkControls | undefined =
    localProjects.length > 0
      ? {
          projects: localProjects,
          devices: [],
          runtimeWork: projectRuntimeWork,
          currentProject: selectedLocalProject,
          currentProjectId: selectedLocalProject?.id,
          executionMode: 'current_workspace',
          onSelectProject: setLocalProjectId,
          onSelectStandaloneDevice: () => undefined,
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
        if (presentation === 'popup' && event.target === event.currentTarget) {
          onCancel()
        }
      }}
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10',
        presentation === 'popup' &&
          'fixed inset-0 z-modal bg-black/30 px-6 py-10 backdrop-blur-[2px]'
      )}
    >
      <section
        ref={panelRef}
        data-testid="workspace-issue-composer-panel"
        role={presentation === 'popup' ? 'dialog' : undefined}
        aria-modal={presentation === 'popup' ? 'true' : undefined}
        aria-label={presentation === 'popup' ? t('todo.new_issue', '新建 Issue') : undefined}
        onKeyDown={event => {
          if (presentation !== 'popup' || event.key !== 'Tab') return
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
          'w-full max-w-[760px]',
          presentation === 'popup' &&
            'max-h-full overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-2xl'
        )}
      >
        <div
          data-testid="workspace-issue-creation-tabs"
          className="mb-3 inline-flex h-9 items-center rounded-xl bg-muted p-1"
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
        {creationMode === 'task' && workbench?.selectProject && selectedLocalProject ? (
          <ConnectedIssueProjectWork
            project={selectedLocalProject}
            onSelectProject={setLocalProjectId}
          >
            {renderComposer}
          </ConnectedIssueProjectWork>
        ) : (
          renderComposer(fallbackProjectWork)
        )}
      </section>
    </div>
  )
}
