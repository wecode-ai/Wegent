// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  ClipboardDocumentIcon,
  TrashIcon,
  ArrowRightOnRectangleIcon,
  FolderPlusIcon,
  FolderIcon,
  PlusIcon,
  PencilIcon,
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
import { useProjectContext } from '@/features/projects'
import { ProjectCreateDialog } from '@/features/projects/components/ProjectCreateDialog'

interface TaskMenuProps {
  taskId: number
  handleCopyTaskId: (taskId: number) => void
  handleDeleteTask: (taskId: number) => void
  onRename?: () => void
  isGroupChat?: boolean
}

export default function TaskMenu({
  taskId,
  handleCopyTaskId,
  handleDeleteTask,
  onRename,
  isGroupChat = false,
}: TaskMenuProps) {
  const { t } = useTranslation()
  const { t: tProjects } = useTranslation('projects')
  const { projects, addTaskToProject } = useProjectContext()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const handleMoveToGroup = async (projectId: number) => {
    await addTaskToProject(projectId, taskId)
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
        <DropdownMenuContent align="end" className="min-w-[120px]">
          <DropdownMenuItem
            onClick={e => {
              e.stopPropagation()
              handleCopyTaskId(taskId)
            }}
          >
            <ClipboardDocumentIcon className="h-3.5 w-3.5 mr-2" />
            {t('common:tasks.copy_task_id')}
          </DropdownMenuItem>

          {/* Move to Group - only for non-group chats */}
          {!isGroupChat && (
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
                  {projects.length > 0 && <DropdownMenuSeparator />}
                  {projects.map(project => (
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
          )}

          {/* Rename Task */}
          {onRename && (
            <DropdownMenuItem
              onClick={e => {
                e.stopPropagation()
                onRename()
              }}
            >
              <PencilIcon className="h-3.5 w-3.5 mr-2" />
              {t('common:tasks.rename_task')}
            </DropdownMenuItem>
          )}

          <DropdownMenuItem
            onClick={e => {
              e.stopPropagation()
              handleDeleteTask(taskId)
            }}
          >
            {isGroupChat ? (
              <>
                <ArrowRightOnRectangleIcon className="h-3.5 w-3.5 mr-2" />
                {t('common:groupChat.leave')}
              </>
            ) : (
              <>
                <TrashIcon className="h-3.5 w-3.5 mr-2" />
                {t('common:tasks.delete_task')}
              </>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create Group Dialog */}
      <ProjectCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </>
  )
}
