// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useDraggable } from '@dnd-kit/core'
import { Task } from '@/types/api'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DraggableTaskWrapperProps {
  task: Task
  children: React.ReactNode
  disabled?: boolean
}

export function DraggableTaskWrapper({
  task,
  children,
  disabled = false,
}: DraggableTaskWrapperProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: {
      type: 'task',
      task,
    },
    disabled,
  })

  return (
    <div ref={setNodeRef} className={cn('relative group/drag', isDragging && 'opacity-50')}>
      {/* Drag handle - visible on hover */}
      {!disabled && (
        <div
          {...listeners}
          {...attributes}
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full',
            'w-5 h-full flex items-center justify-center',
            'cursor-grab active:cursor-grabbing',
            'opacity-0 group-hover/drag:opacity-100 transition-opacity',
            'text-text-muted hover:text-text-primary'
          )}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </div>
      )}
      {children}
    </div>
  )
}
