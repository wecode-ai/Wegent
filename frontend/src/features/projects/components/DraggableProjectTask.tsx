// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useDraggable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { ProjectTask } from '@/types/api'

interface DraggableProjectTaskProps {
  projectId: number
  projectTask: ProjectTask
  children: React.ReactNode
}

/**
 * DraggableProjectTask - Makes a project task draggable
 * When dropped on the history section, the task will be removed from the project
 */
export function DraggableProjectTask({
  projectId,
  projectTask,
  children,
}: DraggableProjectTaskProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `project-task-${projectId}-${projectTask.task_id}`,
    data: {
      type: 'project-task',
      projectId,
      projectTask,
      taskId: projectTask.task_id,
    },
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-50 ring-2 ring-primary ring-inset rounded-md'
      )}
    >
      {children}
    </div>
  )
}
