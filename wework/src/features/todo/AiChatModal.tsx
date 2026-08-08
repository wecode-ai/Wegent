import { Bot, ChevronDown, Plus, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { Attachment, ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

interface AiChatModalProps {
  project: CloudProject
  localProjects: ProjectWithTasks[]
  task?: CloudLoopItem
  /** When false the panel stays mounted (conversation state and stream keep
   * running) but the overlay is hidden, so reopening shows the last messages
   * even while the temporary task is still executing. */
  open: boolean
  onClose: () => void
}

function lastAddressStorageKey(projectId: string | number, taskId?: string): string {
  return `wework-ai-chat:${projectId}:${taskId ?? 'project'}`
}

function storedLastAddress(key: string): RuntimeTaskAddress | null {
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as RuntimeTaskAddress) : null
  } catch {
    return null
  }
}

export function AiChatModal({ project, localProjects, task, open, onClose }: AiChatModalProps) {
  const { t } = useTranslation('common')
  const { createProjectRuntimeTask } = useWorkbenchPaneContext()
  const storageKey = lastAddressStorageKey(project.id, task?.id)
  const [currentAddress, setCurrentAddress] = useState<RuntimeTaskAddress | null>(() =>
    storedLastAddress(storageKey)
  )
  // Compose a fresh temporary task (panel remounts without a saved address)
  // or return to the current conversation. The panel only reads the address on
  // mount, so explicit toggles bump the remount key; creating a new runtime
  // task must NOT remount (the panel already switched to it internally).
  const [composeNew, setComposeNew] = useState(false)
  const [sessionKey, setSessionKey] = useState(0)
  const [localProjectId, setLocalProjectId] = useState<number | null>(() => {
    const matched =
      localProjects.find(candidate => String(candidate.id) === String(project.id)) ??
      localProjects[0]
    return matched?.id ?? null
  })
  const selectedLocalProject =
    localProjects.find(candidate => candidate.id === localProjectId) ?? null

  // The task detail modal stays open underneath; Escape only closes the chat
  // first so the user never loses the task context in one keystroke.
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  const createConversation = useCallback(
    async (
      message: string,
      options: {
        attachments: Attachment[]
        onError: (message: string) => void
        onRuntimeTaskOptimisticOpen: (address: RuntimeTaskAddress) => void
      }
    ) => {
      const address = await createProjectRuntimeTask(message, {
        project: selectedLocalProject,
        attachments: options.attachments,
        collaborationMode: 'default',
        cloudProjectId: String(project.id),
        additionalContext: {
          ...projectSpaceChatRuntimeContext(project),
          ...(task
            ? {
                projectChatTask: {
                  kind: 'application',
                  value: [
                    '<current_task>',
                    JSON.stringify({
                      id: String(task.id),
                      title: task.title,
                      description: task.description ?? '',
                      status: task.status,
                    }),
                    '</current_task>',
                    'This run is bound to this task in the current project space.',
                  ].join('\n'),
                },
              }
            : {}),
        },
        onError: options.onError,
        onRuntimeTaskOptimisticOpen: options.onRuntimeTaskOptimisticOpen,
      })
      return address
    },
    [createProjectRuntimeTask, project, selectedLocalProject, task]
  )

  const rememberAddress = useCallback(
    (address: RuntimeTaskAddress | null) => {
      if (!address) return
      window.localStorage.setItem(storageKey, JSON.stringify(address))
      setCurrentAddress(address)
      setComposeNew(false)
    },
    [storageKey]
  )

  const startNewConversation = useCallback(() => {
    setComposeNew(current => !current)
    setSessionKey(key => key + 1)
  }, [])

  return (
    <div
      data-testid="ai-chat-modal-backdrop"
      className={cn(
        'fixed inset-0 z-critical flex items-center justify-center bg-black/40 p-6',
        !open && 'hidden'
      )}
      onMouseDown={event => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <section
        data-testid="ai-chat-modal"
        className="flex h-[80vh] max-h-[820px] w-[880px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <Bot className="h-4 w-4 shrink-0 text-violet-600" />
          <span className="text-sm font-semibold text-text-primary">
            {t('workbench.project_chat')}
          </span>
          {task ? (
            <span className="min-w-0 truncate text-xs text-text-muted">
              {task.id} · {task.title}
            </span>
          ) : null}
          <label className="relative ml-2 flex h-[26px] max-w-[200px] shrink-0 items-center rounded-full bg-muted/60 transition-colors hover:bg-muted">
            <span className="sr-only">{t('workbench.project_space_chat.runtime_project')}</span>
            <select
              data-testid="ai-chat-runtime-project"
              value={selectedLocalProject?.id ?? ''}
              onChange={event =>
                setLocalProjectId(event.target.value ? Number(event.target.value) : null)
              }
              className="h-full w-full appearance-none truncate rounded-full bg-transparent pl-2.5 pr-[22px] text-xs text-text-primary outline-none"
            >
              <option value="">{t('workbench.project_space_chat.no_runtime_project')}</option>
              {localProjects.map(localProject => (
                <option key={localProject.id} value={localProject.id}>
                  {t('workbench.project_space_chat.runtime_project_prefix', {
                    name: localProject.name,
                  })}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-[7px] h-[11px] w-[11px] text-text-muted" />
          </label>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="ai-chat-new-conversation"
            title={
              composeNew
                ? t('workbench.project_space_chat.back_to_conversation')
                : t('workbench.project_space_chat.new_conversation')
            }
            aria-label={
              composeNew
                ? t('workbench.project_space_chat.back_to_conversation')
                : t('workbench.project_space_chat.new_conversation')
            }
            onClick={startNewConversation}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
          >
            {composeNew ? <Undo2 className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
          </button>
          <button
            type="button"
            data-testid="ai-chat-modal-close"
            onClick={onClose}
            aria-label={t('workbench.project_chat_close')}
            className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <TemporaryChatPanel
          key={sessionKey}
          currentProject={selectedLocalProject}
          source={null}
          instanceId={`ai-chat:${project.id}:${task?.id ?? 'project'}:${sessionKey}`}
          testId="ai-chat-panel"
          initialAddress={composeNew ? null : currentAddress}
          createTask={createConversation}
          onAddressChange={rememberAddress}
        />
      </section>
    </div>
  )
}
