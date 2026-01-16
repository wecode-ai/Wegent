// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  ClipboardDocumentIcon,
  TrashIcon,
  FolderPlusIcon,
  FolderIcon,
  FolderMinusIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { HiOutlineEllipsisVertical } from 'react-icons/hi2'
import { useTranslation } from '@/hooks/useTranslation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown'
import { useProjectContext } from '../contexts/projectContext'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { taskApis } from '@/apis/tasks'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useRouter } from 'next/navigation'

interface ProjectTaskMenuProps {
  taskId: number
  projectId: number
}

export function ProjectTaskMenu({ taskId, projectId }: ProjectTaskMenuProps) {
  const { t } = useTranslation()
  const { t: tProjects } = useTranslation('projects')
  const router = useRouter()
  const { projects, addTaskToProject, removeTaskFromProject } = useProjectContext()
  const { setSelectedTask, refreshTasks } = useTaskContext()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  // Filter out the current project from the list
  const otherProjects = projects.filter(p => p.id !== projectId)

  const handleCopyTaskId = async () => {
    const textToCopy = taskId.toString()
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(textToCopy)
        return
      } catch (err) {
        console.error('Copy failed', err)
      }
    }
    try {
      const textarea = document.createElement('textarea')
      textarea.value = textToCopy
      textarea.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    } catch (err) {
      console.error('Fallback copy failed', err)
    }
  }

  const handleMoveToGroup = async (targetProjectId: number) => {
    // First remove from current project, then add to new project
    await removeTaskFromProject(projectId, taskId)
    await addTaskToProject(targetProjectId, taskId)
  }

  const handleRemoveFromGroup = async () => {
    await removeTaskFromProject(projectId, taskId)
  }

  const handleDeleteTask = async () => {
    try {
      await taskApis.deleteTask(taskId)
      setSelectedTask(null)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.delete('taskId')
        router.replace(url.pathname + url.search)
        refreshTasks()
      }
    } catch (err) {
      console.error('Delete failed', err)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          onClick={e => e.stopPropagation()}
          className="flex items-center justify-center text-text-muted hover:text-text-primary px-1 outline-none"
        >
          <HiOutlineEllipsisVertical className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[140px]">
          {/* Copy Task ID */}
          <DropdownMenuItem
            onClick={e => {
              e.stopPropagation()
              handleCopyTaskId()
            }}
          >
            <ClipboardDocumentIcon className="h-3.5 w-3.5 mr-2" />
            {t('common:tasks.copy_task_id')}
          </DropdownMenuItem>

          {/* Move to Group */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger onClick={e => e.stopPropagation()}>
              <FolderPlusIcon className="h-3.5 w-3.5 mr-2" />
              {tProjects('menu.moveToGroup')}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="min-w-[140px]">
                <DropdownMenuItem
                  onClick={e => {
                    e.stopPropagation()
                    setCreateDialogOpen(true)
                  }}
                >
                  <PlusIcon className="h-3.5 w-3.5 mr-2" />
                  {tProjects('menu.createGroup')}
                </DropdownMenuItem>
                {otherProjects.length > 0 && <DropdownMenuSeparator />}
                {otherProjects.map(project => (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={e => {
                      e.stopPropagation()
                      handleMoveToGroup(project.id)
                    }}
                  >
                    <FolderIcon
                      className="h-3.5 w-3.5 mr-2"
                      style={{ color: project.color || 'currentColor' }}
                    />
                    <span className="truncate">{project.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          {/* Remove from Group */}
          <DropdownMenuItem
            onClick={e => {
              e.stopPropagation()
              handleRemoveFromGroup()
            }}
          >
            <FolderMinusIcon className="h-3.5 w-3.5 mr-2" />
            {tProjects('menu.removeFromGroup')}
          </DropdownMenuItem>

          {/* Delete Task */}
          <DropdownMenuItem
            onClick={e => {
              e.stopPropagation()
              handleDeleteTask()
            }}
          >
            <TrashIcon className="h-3.5 w-3.5 mr-2" />
            {t('common:tasks.delete_task')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create Group Dialog */}
      <ProjectCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </>
  )
}
