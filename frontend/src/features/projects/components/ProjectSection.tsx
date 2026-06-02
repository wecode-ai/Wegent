// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  ChevronUp,
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
import { ProjectWithTasks, ProjectTask } from '@/types/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
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
  const { selectTask } = useTaskSession()
  const isWorkspaceSection = variant === 'workspace'
  const isGroupSection = variant === 'group'
  const isUnifiedSection = variant === 'all'

  const handleNewConversation = useCallback(
    (project: ProjectWithTasks) => {
      setSelectedProjectTaskId(null)
      selectTask(null)

      const params = new URLSearchParams()
      params.set('projectId', String(project.id))
      const deviceId = project.config?.execution?.deviceId
      if (deviceId) {
        params.set('deviceId', deviceId)
      }
      router.push(`/devices/chat?${params.toString()}`)
      onTaskSelect?.()
    },
    [setSelectedProjectTaskId, selectTask, router, onTaskSelect]
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
  const [sectionCollapsed, setSectionCollapsed] = useState(true)
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
    // Set project task as selected (for project section highlight)
    setSelectedProjectTaskId(projectTask.task_id)

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
        className="group flex h-6 items-center justify-between rounded-md px-1 text-xs font-medium text-text-muted hover:bg-[rgb(238,238,238)] hover:text-text-primary dark:hover:bg-white/10 transition-colors"
        data-testid="project-section-header"
      >
        <button
          type="button"
          data-testid="project-section-toggle"
          onClick={() => setSectionCollapsed(!sectionCollapsed)}
          aria-expanded={!sectionCollapsed}
          className="flex h-full min-w-0 flex-1 items-center justify-between"
        >
          <span className="truncate">{sectionTitle}</span>
          {sectionCollapsed ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" />
          )}
        </button>
        <Button
          data-testid={
            isUnifiedSection || isWorkspaceSection
              ? 'create-workspace-project-button'
              : 'create-group-button'
          }
          variant="ghost"
          size="sm"
          className="ml-1 h-5 w-5 p-0 text-text-muted hover:text-text-primary transition-colors rounded"
          onClick={() => setCreateDialogOpen(true)}
          title={t(
            isUnifiedSection || isWorkspaceSection ? 'workspaceCreate.title' : 'create.title'
          )}
        >
          <FolderPlus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Project List */}
      {!sectionCollapsed && (
        <div className="mt-1 space-y-0.5" data-testid="project-section-list">
          {isLoading ? (
            <div className="px-4 py-2 text-xs text-text-muted">{t('common:loading')}</div>
          ) : visibleProjects.length === 0 ? (
            <div className="px-4 py-2 text-xs text-text-muted">
              {t(
                isUnifiedSection || isWorkspaceSection ? 'workspaceSection.empty' : 'section.empty'
              )}
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
      )}

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

  return (
    <div className="group">
      {/* Project Header */}
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer',
          'hover:bg-surface transition-colors'
        )}
      >
        {/* Expand/Collapse Button */}
        <button
          onClick={onToggleExpand}
          className="flex items-center justify-center w-5 h-5 text-text-secondary hover:text-text-primary"
        >
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>

        {/* Project Icon */}
        <div
          className="flex items-center justify-center w-5 h-5"
          style={{ color: project.color || 'var(--color-text-secondary)' }}
        >
          {isExpanded ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
        </div>

        {/* Project Name */}
        <span className="flex-1 text-sm text-text-primary truncate" onClick={onToggleExpand}>
          {project.name}
        </span>

        {/* Actions Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-primary"
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
            className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-primary"
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
        <div className="ml-6 space-y-0.5">
          {project.tasks?.map(projectTask => {
            const isSelected = selectedProjectTaskId === projectTask.task_id
            const isEditing = editingTaskId === projectTask.task_id
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
                    'group/task flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer',
                    'text-sm transition-colors',
                    isSelected
                      ? 'bg-primary/10 text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface'
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
                      className="flex-1 truncate"
                      onDoubleClick={e => handleDoubleClick(e, projectTask.task_id)}
                    >
                      {projectTask.task_title || `Task #${projectTask.task_id}`}
                    </span>
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
        </div>
      )}

      {/* Empty State (when expanded but no tasks) */}
      {isExpanded && taskCount === 0 && (
        <div className="ml-6 px-2 py-1">
          <span className="text-xs text-text-muted">{t('section.noTasks')}</span>
        </div>
      )}
    </div>
  )
}
