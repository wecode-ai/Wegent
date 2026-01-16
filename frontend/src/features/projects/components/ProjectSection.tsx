// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderOpen,
  Folder,
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
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'

interface ProjectSectionProps {
  onTaskSelect?: () => void
}

export function ProjectSection({ onTaskSelect }: ProjectSectionProps) {
  const { t } = useTranslation('projects')
  const router = useRouter()
  const {
    projects,
    isLoading,
    expandedProjects,
    toggleProjectExpanded,
    selectedProjectTaskId,
    setSelectedProjectTaskId,
  } = useProjectContext()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [selectedProject, setSelectedProject] = useState<ProjectWithTasks | null>(null)

  // Section collapsed state
  const [sectionCollapsed, setSectionCollapsed] = useState(false)

  const handleEditProject = (project: ProjectWithTasks) => {
    setSelectedProject(project)
    setEditDialogOpen(true)
  }

  const handleDeleteProject = (project: ProjectWithTasks) => {
    setSelectedProject(project)
    setDeleteDialogOpen(true)
  }

  // Handle task click - navigate to the task
  const handleTaskClick = (projectTask: ProjectTask) => {
    // Clear all stream states when switching tasks
    clearAllStreams()

    // Set project task as selected (for project section highlight)
    setSelectedProjectTaskId(projectTask.task_id)

    // Clear TaskContext's selectedTask to remove highlight from history section
    setSelectedTask(null)

    // Navigate to the appropriate page based on task type
    const params = new URLSearchParams()
    params.set('taskId', String(projectTask.task_id))

    // Determine target path based on is_group_chat flag
    // Group chats and regular chats go to chat page
    const targetPath = paths.chat.getHref()

    router.push(`${targetPath}?${params.toString()}`)

    // Call the onTaskSelect callback if provided (to close mobile sidebar)
    onTaskSelect?.()
  }

  return (
    <div className="pb-3 mb-2">
      {/* Section Header */}
      <div className="flex items-center justify-between px-1 py-1.5 group">
        <button
          onClick={() => setSectionCollapsed(!sectionCollapsed)}
          className="flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text-primary transition-colors"
        >
          {sectionCollapsed ? (
            <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          <span>{t('section.title')}</span>
          <span className="text-text-muted ml-1">({projects.length})</span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => setCreateDialogOpen(true)}
          title={t('create.title')}
        >
          <FolderPlus className="w-3.5 h-3.5 text-text-muted" />
        </Button>
      </div>

      {/* Project List */}
      {!sectionCollapsed && (
        <div className="space-y-0.5">
          {isLoading ? (
            <div className="px-4 py-2 text-xs text-text-muted">{t('common:loading')}</div>
          ) : projects.length === 0 ? (
            <div className="px-4 py-2 text-xs text-text-muted">{t('section.empty')}</div>
          ) : (
            projects.map(project => (
              <DroppableProject key={project.id} projectId={project.id}>
                <ProjectItem
                  project={project}
                  isExpanded={expandedProjects.has(project.id)}
                  onToggleExpand={() => toggleProjectExpanded(project.id)}
                  onEdit={() => handleEditProject(project)}
                  onDelete={() => handleDeleteProject(project)}
                  onTaskClick={handleTaskClick}
                  selectedProjectTaskId={selectedProjectTaskId}
                />
              </DroppableProject>
            ))
          )}
        </div>
      )}

      {/* Dialogs */}
      <ProjectCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
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
  onTaskClick: (projectTask: ProjectTask) => void
  selectedProjectTaskId: number | null
}

function ProjectItem({
  project,
  isExpanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onTaskClick,
  selectedProjectTaskId,
}: ProjectItemProps) {
  const { t } = useTranslation('projects')
  const taskCount = project.tasks?.length || 0

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

        {/* Task Count */}
        <span className="text-xs text-text-muted mr-1">{taskCount}</span>

        {/* Actions Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
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
      </div>

      {/* Task List (when expanded) */}
      {isExpanded && taskCount > 0 && (
        <div className="ml-6 space-y-0.5">
          {project.tasks?.map(projectTask => {
            const isSelected = selectedProjectTaskId === projectTask.task_id
            return (
              <DraggableProjectTask
                key={projectTask.task_id}
                projectId={project.id}
                projectTask={projectTask}
              >
                <div
                  onClick={() => onTaskClick(projectTask)}
                  className={cn(
                    'group/task flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer',
                    'text-sm transition-colors',
                    isSelected
                      ? 'bg-primary/10 text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface'
                  )}
                >
                  <span className="flex-1 truncate">
                    {projectTask.task_title || `Task #${projectTask.task_id}`}
                  </span>
                  <div className="opacity-0 group-hover/task:opacity-100 transition-opacity">
                    <ProjectTaskMenu taskId={projectTask.task_id} projectId={project.id} />
                  </div>
                </div>
              </DraggableProjectTask>
            )
          })}
        </div>
      )}

      {/* Empty State (when expanded but no tasks) */}
      {isExpanded && taskCount === 0 && (
        <div className="ml-6 px-2 py-1 text-xs text-text-muted">{t('section.noTasks')}</div>
      )}
    </div>
  )
}
