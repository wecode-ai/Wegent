import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowUpRight, Folder, MessageCircle, Pin, Settings } from 'lucide-react'
import { useState } from 'react'

import { TextInputDialog } from '@/components/common/TextInputDialog'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { isLocalTerminalAvailable, openLocalWorkspace } from '@/lib/local-terminal'
import {
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectSidebarStateKey,
} from '@/lib/runtime-project-state'
import { cn } from '@/lib/utils'
import type { RuntimeProjectWork, RuntimeTaskAddress } from '@/types/api'
import { ConversationProjectEditor } from './ConversationProjectEditor'
import { getRuntimeSidebarTaskItems, shortenSidebarHomePath } from './runtimeTaskSidebarHelpers'

export function ConversationHeaderTitle({
  title,
  displayTitle,
  address,
  projectWork,
}: {
  title: string
  displayTitle: string
  address: RuntimeTaskAddress
  projectWork?: RuntimeProjectWork
}) {
  const { t } = useTranslation('common')
  const { state, renameRuntimeTask, setRuntimeProjectPinned } = useWorkbench()
  const [renaming, setRenaming] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [openingRoot, setOpeningRoot] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [editingProject, setEditingProject] = useState(false)
  const project = projectWork?.project
  const workspacePath = address.workspacePath
  const roots = Array.from(
    new Set(
      (project?.roots?.length
        ? project.roots.map(root => root.path)
        : projectWork
          ? projectWork.deviceWorkspaces.map(workspace => workspace.workspacePath)
          : [workspacePath ?? '']
      )
        .map(path => path.trim())
        .filter(Boolean)
    )
  )
  const taskCount = projectWork
    ? (projectWork.totalTasks ?? getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).length)
    : null
  const projectLabel = project?.name ?? t('workbench.conversation_workspace')
  const localDeviceId = getLocalRuntimeStateDeviceId(state.devices)
  const pinDeviceId = localDeviceId ?? project?.stateDeviceId ?? address.deviceId

  const canOpenRoot = (path: string) =>
    Boolean(
      localDeviceId &&
      isLocalTerminalAvailable() &&
      project?.source !== 'remote_project' &&
      project?.kind !== 'remote' &&
      ((project?.roots?.some(root => root.path.trim() === path) &&
        project.stateDeviceId === localDeviceId) ||
        projectWork?.deviceWorkspaces.some(
          workspace =>
            workspace.workspacePath.trim() === path &&
            workspace.deviceId === localDeviceId &&
            workspace.workspaceSource !== 'remote'
        ) ||
        (!projectWork && address.deviceId === localDeviceId))
    )

  const openRoot = async (path: string) => {
    if (openingRoot || !canOpenRoot(path)) return
    setOpeningRoot(true)
    setActionError(null)
    try {
      await openLocalWorkspace({ opener: 'file-manager', path })
      setProjectOpen(false)
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t('workbench.open_project_folder_failed')
      )
    } finally {
      setOpeningRoot(false)
    }
  }

  const togglePin = async () => {
    if (!project || pinning) return
    setPinning(true)
    setActionError(null)
    try {
      await setRuntimeProjectPinned({
        deviceId: pinDeviceId,
        projectKey: getRuntimeProjectSidebarStateKey(project),
        pinned: !project.pinned,
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('workbench.save_failed'))
    } finally {
      setPinning(false)
    }
  }

  return (
    <div className="electron-titlebar-interactive-region pointer-events-auto flex min-w-0 max-w-full items-center gap-1">
      {(project || workspacePath) && (
        <Popover open={projectOpen} onOpenChange={setProjectOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                data-testid="conversation-project-button"
                aria-label={t('workbench.conversation_project_details')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-muted data-[open]:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary"
              />
            }
          >
            <Folder className="h-4 w-4" />
          </PopoverTrigger>
          <>
            <PopoverContent
              data-testid="conversation-project-popover"
              aria-label={projectLabel}
              align="start"
              sideOffset={6}
              collisionPadding={8}
              finalFocus={editingProject ? 'none' : 'trigger'}
              className="electron-titlebar-interactive-region z-popover max-h-[var(--available-height)] w-[336px] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border/60 bg-popover p-2 text-base text-text-primary shadow-sm outline-none"
            >
              <div className="flex h-7 min-w-0 items-center gap-2 px-1">
                <Folder className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-base font-medium">
                  {projectLabel}
                </span>
                {project && (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="conversation-project-pin"
                    disabled={pinning}
                    aria-label={t(
                      project.pinned ? 'workbench.unpin_project' : 'workbench.pin_project'
                    )}
                    aria-pressed={Boolean(project.pinned)}
                    onClick={() => void togglePin()}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
                  >
                    <Pin className={cn('h-4 w-4 rotate-45', project.pinned && 'fill-current')} />
                  </ControlButton>
                )}
              </div>
              {taskCount !== null && (
                <div
                  data-testid="conversation-project-task-count"
                  className="flex h-7 items-center gap-2 px-1"
                >
                  <MessageCircle className="h-4 w-4 shrink-0 text-text-muted" />
                  <span>{t('workbench.project_hover_task_count', { count: taskCount })}</span>
                </div>
              )}
              {roots.length > 0 && (
                <div className="my-1 border-t border-border/60 pt-1">
                  {roots.map(path => (
                    <ControlButton
                      variant="unstyled"
                      key={path}
                      type="button"
                      data-testid="conversation-project-root"
                      disabled={openingRoot || !canOpenRoot(path)}
                      onClick={() => void openRoot(path)}
                      aria-label={t('workbench.open_project_source', {
                        source: shortenSidebarHomePath(path),
                      })}
                      className="group/root flex min-h-6 w-full items-center gap-2 rounded-lg px-1 text-left enabled:hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-default"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 break-all" title={path}>
                        {shortenSidebarHomePath(path)}
                      </span>
                      {canOpenRoot(path) && (
                        <ArrowUpRight
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0 text-text-muted opacity-0 group-hover/root:opacity-100 group-focus-visible/root:opacity-100"
                        />
                      )}
                    </ControlButton>
                  ))}
                </div>
              )}
              {projectWork && (
                <div className="mt-1 border-t border-border/60 pt-1">
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="conversation-project-edit"
                    onClick={() => {
                      setEditingProject(true)
                      setProjectOpen(false)
                    }}
                    className="flex h-7 w-full items-center gap-2 rounded-lg px-1 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <Settings className="h-4 w-4 shrink-0 text-text-muted" />
                    <span>{t('workbench.edit_project')}</span>
                  </ControlButton>
                </div>
              )}
              {actionError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {actionError}
                </p>
              )}
            </PopoverContent>
          </>
        </Popover>
      )}
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="conversation-rename-button"
        aria-label={t('workbench.rename_chat')}
        onClick={event => {
          if (event.detail > 0) event.currentTarget.blur()
          setRenaming(true)
        }}
        className="h-7 min-w-0 truncate rounded-md px-1 text-left hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary"
      >
        {displayTitle}
      </ControlButton>
      <TextInputDialog
        open={renaming}
        title={t('workbench.rename_chat')}
        label={t('workbench.chat_name')}
        initialValue={title}
        confirmLabel={t('workbench.save')}
        cancelLabel={t('workbench.cancel')}
        inputTestId="conversation-rename-input"
        confirmTestId="conversation-rename-confirm"
        onClose={() => setRenaming(false)}
        onSubmit={value => renameRuntimeTask(address, value)}
      />
      {editingProject && projectWork && (
        <ConversationProjectEditor
          projectWork={projectWork}
          onClose={() => setEditingProject(false)}
        />
      )}
    </div>
  )
}
