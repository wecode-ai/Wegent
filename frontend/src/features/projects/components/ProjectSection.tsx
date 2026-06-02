// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronRight,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderOpen,
  Folder,
  SquarePen,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useProjectContext } from '../contexts/projectContext'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { ProjectEditDialog } from './ProjectEditDialog'
import { ProjectDeleteDialog } from './ProjectDeleteDialog'
import { DroppableProject } from './DroppableProject'
import { DraggableProjectTask } from './DraggableProjectTask'
import { ProjectTaskMenu } from './ProjectTaskMenu'
import { ProjectWithTasks, ProjectTask, Task } from '@/types/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { TaskInlineRename } from '@/components/common/TaskInlineRename'
import { taskApis } from '@/apis/tasks'
import {
  canImportOrdinaryTaskToProject,
  canStartProjectConversation,
  isPathlessProject,
  isWorkspaceProject,
} from '../utils/projectClassification'

interface ProjectSectionProps {
  onTaskSelect?: () => void
  variant?: 'all' | 'group' | 'workspace'
}

const DEFAULT_VISIBLE_PROJECT_TASKS = 5
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export function ProjectSection({ onTaskSelect, variant = 'all' }: ProjectSectionProps) {
  const { t } = useTranslation('projects')
  const router = useRouter()
  const {
    projects,
    isLoading,
    expandedProjects,
    toggleProjectExpanded,
    selectedProjectTaskId,
    setSelectedProjectTaskId,
    refreshProjects,
  } = useProjectContext()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const isWorkspaceSection = variant === 'workspace'
  const isGroupSection = variant === 'group'
  const isUnifiedSection = variant === 'all'

  const handleNewConversation = useCallback(
    (project: ProjectWithTasks) => {
      clearAllStreams()
      setSelectedProjectTaskId(null)
      setSelectedTask(null as unknown as Task)

      const params = new URLSearchParams()
      params.set('projectId', String(project.id))
      const deviceId = project.config?.execution?.deviceId
      if (deviceId) {
        params.set('deviceId', deviceId)
      }
      router.push(`/devices/chat?${params.toString()}`)
      onTaskSelect?.()
    },
    [clearAllStreams, setSelectedProjectTaskId, setSelectedTask, router, onTaskSelect]
  )
  const visibleProjects = projects.filter(project => {
    if (isWorkspaceSection) {
      return isWorkspaceProject(project)
    }
    if (isGroupSection) {
      return isPathlessProject(project)
    }
    return true
  })

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [selectedProject, setSelectedProject] = useState<ProjectWithTasks | null>(null)

  // Section collapsed state
  const sectionTitle = t(
    isUnifiedSection || isWorkspaceSection ? 'workspaceSection.title' : 'section.title'
  )

  const handleEditProject = (project: ProjectWithTasks) => {
    setSelectedProject(project)
    setEditDialogOpen(true)
  }

  const handleDeleteProject = (project: ProjectWithTasks) => {
    setSelectedProject(project)
    setDeleteDialogOpen(true)
  }

  // Handle task click - navigate to the task
  const handleTaskClick = (projectTask: ProjectTask, project: ProjectWithTasks) => {
    // Clear all stream states when switching tasks
    clearAllStreams()

    // Set project task as selected (for project section highlight)
    setSelectedProjectTaskId(projectTask.task_id)

    // IMPORTANT: Set selected task with minimal data to prevent "New Conversation" flash
    setSelectedTask({
      id: projectTask.task_id,
      title: projectTask.task_title || '',
      status: projectTask.task_status,
      is_group_chat: projectTask.is_group_chat,
    } as Task)

    const params = new URLSearchParams()
    params.set('taskId', String(projectTask.task_id))

    if (isWorkspaceProject(project)) {
      // Workspace tasks go directly to /devices/chat with projectId + deviceId
      params.set('projectId', String(project.id))
      const deviceId = project.config?.execution?.deviceId
      if (deviceId) {
        params.set('deviceId', deviceId)
      }
      router.push(`/devices/chat?${params.toString()}`)
    } else {
      router.push(`${paths.chat.getHref()}?${params.toString()}`)
    }

    onTaskSelect?.()
  }

  return (
    <div className="mb-0">
      {/* Section Header */}
      <div
        className="group flex h-8 items-center justify-between px-1 text-sm font-semibold text-text-muted"
        data-testid="project-section-header"
      >
        <button
          type="button"
          data-testid="project-section-toggle"
          aria-expanded={true}
          className="flex h-full min-w-0 flex-1 items-center"
        >
          <span className="truncate">{sectionTitle}</span>
        </button>
        <Button
          data-testid={
            isUnifiedSection || isWorkspaceSection
              ? 'create-workspace-project-button'
              : 'create-group-button'
          }
          variant="ghost"
          size="sm"
          className="ml-1 h-8 min-w-8 w-8 p-0 text-text-muted opacity-0 transition-colors hover:text-text-primary group-hover:opacity-100"
          onClick={() => setCreateDialogOpen(true)}
          title={t(
            isUnifiedSection || isWorkspaceSection ? 'workspaceCreate.title' : 'create.title'
          )}
        >
          <FolderPlus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Project List */}
      <div className="mt-2 space-y-3" data-testid="project-section-list">
        {isLoading ? (
          <div className="px-4 py-2 text-xs text-text-muted">{t('common:loading')}</div>
        ) : visibleProjects.length === 0 ? (
          <div className="px-4 py-2 text-xs text-text-muted">
            {t(isUnifiedSection || isWorkspaceSection ? 'workspaceSection.empty' : 'section.empty')}
          </div>
        ) : (
          visibleProjects.map(project => (
            <DroppableProject
              key={project.id}
              projectId={project.id}
              disabled={!canImportOrdinaryTaskToProject(project)}
            >
              <ProjectItem
                project={project}
                isExpanded={expandedProjects.has(project.id)}
                onToggleExpand={() => toggleProjectExpanded(project.id)}
                onEdit={() => handleEditProject(project)}
                onDelete={() => handleDeleteProject(project)}
                onTaskClick={handleTaskClick}
                selectedProjectTaskId={selectedProjectTaskId}
                onRefreshProjects={refreshProjects}
                isWorkspace={isWorkspaceProject(project)}
                onNewConversation={
                  canStartProjectConversation(project) ? handleNewConversation : undefined
                }
              />
            </DroppableProject>
          ))
        )}
      </div>

      {/* Dialogs */}
      <ProjectCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        mode={isUnifiedSection || isWorkspaceSection ? 'workspace' : 'group'}
      />
      <ProjectEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        project={selectedProject}
      />
      <ProjectDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        project={selectedProject}
      />
    </div>
  )
}

interface ProjectItemProps {
  project: ProjectWithTasks
  isExpanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
  onDelete: () => void
  onTaskClick: (projectTask: ProjectTask, project: ProjectWithTasks) => void
  selectedProjectTaskId: number | null
  onRefreshProjects: () => Promise<void>
  isWorkspace?: boolean
  onNewConversation?: (project: ProjectWithTasks) => void
}

function ProjectItem({
  project,
  isExpanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onTaskClick,
  selectedProjectTaskId,
  onRefreshProjects,
  isWorkspace,
  onNewConversation,
}: ProjectItemProps) {
  const { t } = useTranslation('projects')
  const taskCount = project.tasks?.length || 0
  const [showAllTasks, setShowAllTasks] = useState(false)
  const visibleTasks = showAllTasks
    ? project.tasks
    : project.tasks?.slice(0, DEFAULT_VISIBLE_PROJECT_TASKS)
  const hasHiddenTasks = taskCount > DEFAULT_VISIBLE_PROJECT_TASKS

  // Track which task is being renamed
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null)

  // Handle double-click to start renaming
  const handleDoubleClick = useCallback((e: React.MouseEvent, taskId: number) => {
    e.stopPropagation()
    e.preventDefault()
    setEditingTaskId(taskId)
  }, [])

  // Handle rename save
  const handleRenameSave = useCallback(
    async (taskId: number, newTitle: string) => {
      await taskApis.updateTask(taskId, { title: newTitle })
      // Refresh projects to update task_title
      await onRefreshProjects()
    },
    [onRefreshProjects]
  )

  const formatTimeAgo = (dateString?: string | null) => {
    if (!dateString) return ''

    const diffMs = Math.max(0, Date.now() - new Date(dateString).getTime())
    if (diffMs < HOUR_MS) {
      return t('relativeTime.minute', { count: Math.max(1, Math.floor(diffMs / MINUTE_MS)) })
    }
    if (diffMs < DAY_MS) {
      return t('relativeTime.hour', { count: Math.floor(diffMs / HOUR_MS) })
    }
    if (diffMs < WEEK_MS) {
      return t('relativeTime.day', { count: Math.floor(diffMs / DAY_MS) })
    }
    return t('relativeTime.week', { count: Math.floor(diffMs / WEEK_MS) })
  }

  return (
    <div className="group">
      {/* Project Header */}
      <div
        className={cn(
          'flex h-8 items-center gap-2 rounded-md px-1 text-text-secondary',
          'transition-colors hover:text-text-primary'
        )}
      >
        {/* Expand/Collapse Button */}
        <button
          onClick={onToggleExpand}
          className="flex h-8 min-w-8 items-center justify-center text-text-secondary hover:text-text-primary"
          data-testid="project-item-toggle"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
          />
        </button>

        {/* Project Icon */}
        <div
          className="flex h-6 w-6 items-center justify-center"
          style={{ color: project.color || 'var(--color-text-secondary)' }}
        >
          {isExpanded ? <FolderOpen className="h-5 w-5" /> : <Folder className="h-5 w-5" />}
        </div>

        {/* Project Name */}
        <span
          className="flex-1 truncate text-sm font-medium text-text-secondary"
          onClick={onToggleExpand}
        >
          {project.name}
        </span>

        {/* Actions Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 min-w-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-primary"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="w-3.5 h-3.5 mr-2" />
              {t('actions.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <Trash2 className="w-3.5 h-3.5 mr-2" />
              {t('actions.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* New conversation button (workspace projects only, on hover) */}
        {onNewConversation && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 min-w-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-primary"
            onClick={e => {
              e.stopPropagation()
              onNewConversation(project)
            }}
            title={t('workspace.newConversation')}
            data-testid="project-new-conversation-btn"
          >
            <SquarePen className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {/* Task List (when expanded) */}
      {isExpanded && taskCount > 0 && (
        <div className="ml-12 space-y-0.5">
          {visibleTasks?.map(projectTask => {
            const isSelected = selectedProjectTaskId === projectTask.task_id
            const isEditing = editingTaskId === projectTask.task_id
            const timeAgo = formatTimeAgo(projectTask.updated_at)
            return (
              <DraggableProjectTask
                key={projectTask.task_id}
                projectId={project.id}
                projectTask={projectTask}
              >
                <div
                  onClick={() => {
                    // Don't navigate when editing
                    if (!isEditing) {
                      onTaskClick(projectTask, project)
                    }
                  }}
                  className={cn(
                    'group/task flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2',
                    'text-sm transition-colors',
                    isSelected
                      ? 'bg-surface text-text-primary'
                      : 'text-text-primary hover:bg-surface'
                  )}
                >
                  {isEditing ? (
                    <TaskInlineRename
                      taskId={projectTask.task_id}
                      initialTitle={projectTask.task_title || `Task #${projectTask.task_id}`}
                      isEditing={true}
                      onEditEnd={() => setEditingTaskId(null)}
                      onSave={async (newTitle: string) => {
                        await handleRenameSave(projectTask.task_id, newTitle)
                      }}
                    />
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate font-medium"
                      onDoubleClick={e => handleDoubleClick(e, projectTask.task_id)}
                    >
                      {projectTask.task_title || `Task #${projectTask.task_id}`}
                    </span>
                  )}
                  {timeAgo && (
                    <span className="shrink-0 text-xs font-medium text-text-muted">{timeAgo}</span>
                  )}
                  <div className="opacity-0 group-hover/task:opacity-100 transition-opacity">
                    <ProjectTaskMenu
                      taskId={projectTask.task_id}
                      projectId={project.id}
                      onRename={() => setEditingTaskId(projectTask.task_id)}
                      isWorkspace={isWorkspace}
                    />
                  </div>
                </div>
              </DraggableProjectTask>
            )
          })}
          {hasHiddenTasks && !showAllTasks && (
            <button
              type="button"
              data-testid="project-show-more-tasks-button"
              onClick={() => setShowAllTasks(true)}
              className="flex h-8 min-w-[44px] items-center rounded-md px-2 text-sm font-semibold text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
            >
              {t('workspaceSection.showMore')}
            </button>
          )}
        </div>
      )}

      {/* Empty State (when expanded but no tasks) */}
      {isExpanded && taskCount === 0 && (
        <div className="ml-12 px-2 py-1">
          <span className="text-xs text-text-muted">{t('section.noTasks')}</span>
        </div>
      )}
    </div>
  )
}
