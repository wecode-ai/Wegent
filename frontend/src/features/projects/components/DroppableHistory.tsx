// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'

interface DroppableHistoryProps {
  children: React.ReactNode
}

/**
 * DroppableHistory - A drop zone for the history section
 * When a project task is dropped here, it will be removed from its project
 */
export function DroppableHistory({ children }: DroppableHistoryProps) {
  const { isOver, setNodeRef, active } = useDroppable({
    id: 'history-section',
    data: {
      type: 'history',
    },
  })

  // Only highlight when dragging a project task (not a regular task)
  const isProjectTaskDragging = active?.data?.current?.type === 'project-task'
  const showHighlight = isOver && isProjectTaskDragging

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'transition-all duration-200',
        showHighlight && 'bg-primary/5 ring-2 ring-primary/50 ring-inset rounded-md'
      )}
    >
      {children}
    </div>
  )
}
