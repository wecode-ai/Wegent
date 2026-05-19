// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'

interface DroppableProjectProps {
  projectId: number
  disabled?: boolean
  children: React.ReactNode
}

export function DroppableProject({ projectId, disabled = false, children }: DroppableProjectProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: `project-${projectId}`,
    disabled,
    data: {
      type: 'project',
      projectId,
    },
  })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'transition-all duration-200',
        isOver && !disabled && 'bg-primary/10 ring-2 ring-primary ring-inset rounded-md'
      )}
    >
      {children}
    </div>
  )
}
