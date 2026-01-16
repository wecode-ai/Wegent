// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useCallback } from 'react'
import {
  DndContext as DndKitContext,
  DragOverlay,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  useSensor,
  useSensors,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  CollisionDetection,
} from '@dnd-kit/core'
import { Task } from '@/types/api'
import { useProjectContext } from './projectContext'
import { GripVertical } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

interface DraggedTask {
  id: number
  title: string
  task: Task
}

interface DndContextValue {
  isDragging: boolean
  draggedTask: DraggedTask | null
  activeDropTarget: number | null
}

const DndContext = createContext<DndContextValue | undefined>(undefined)

export function useDndContext() {
  const context = useContext(DndContext)
  if (context === undefined) {
    throw new Error('useDndContext must be used within a TaskDndProvider')
  }
  return context
}

interface TaskDndProviderProps {
  children: React.ReactNode
}

export function TaskDndProvider({ children }: TaskDndProviderProps) {
  const { addTaskToProject, removeTaskFromProject } = useProjectContext()
  const { toast } = useToast()
  const { t } = useTranslation('projects')
  const [draggedTask, setDraggedTask] = useState<DraggedTask | null>(null)
  const [activeDropTarget, setActiveDropTarget] = useState<number | null>(null)

  // Custom collision detection: prioritize projects over history
  // This ensures that when dragging over a project, it takes precedence
  // But when not over any project, the history section can be detected
  const customCollisionDetection: CollisionDetection = useCallback(args => {
    // First, check for pointer within collisions
    const pointerCollisions = pointerWithin(args)

    // If we have collisions, prioritize project over history
    if (pointerCollisions.length > 0) {
      // Find project collisions first
      const projectCollision = pointerCollisions.find(
        collision => collision.data?.droppableContainer?.data?.current?.type === 'project'
      )
      if (projectCollision) {
        return [projectCollision]
      }

      // If no project collision, check for history
      const historyCollision = pointerCollisions.find(
        collision => collision.data?.droppableContainer?.data?.current?.type === 'history'
      )
      if (historyCollision) {
        return [historyCollision]
      }
    }

    // Fallback to rect intersection
    return rectIntersection(args)
  }, [])

  // Configure sensors for both mouse and touch
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Minimum drag distance before activation
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200, // Delay before drag starts on touch
        tolerance: 5,
      },
    })
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event
    const data = active.data.current

    if (data?.type === 'task' && data?.task) {
      // Dragging from history to project
      setDraggedTask({
        id: data.task.id,
        title: data.task.title,
        task: data.task,
      })
    } else if (data?.type === 'project-task' && data?.projectTask) {
      // Dragging from project to history
      const projectTask = data.projectTask
      setDraggedTask({
        id: projectTask.task_id,
        title: projectTask.task_title || `Task #${projectTask.task_id}`,
        task: { id: projectTask.task_id, title: projectTask.task_title } as Task,
      })
    }
  }, [])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event

    if (over && over.data.current?.type === 'project') {
      setActiveDropTarget(over.data.current.projectId as number)
    } else if (over && over.data.current?.type === 'history') {
      // Use -1 to indicate history section as drop target
      setActiveDropTarget(-1)
    } else {
      setActiveDropTarget(null)
    }
  }, [])

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      const activeData = active.data.current

      if (over && over.data.current?.type === 'project' && activeData?.type === 'task') {
        // Check if the task is a group chat
        const task = activeData.task as Task
        if (task.is_group_chat) {
          toast({
            description: t('toast.groupChatNotSupported'),
            variant: 'destructive',
          })
          setDraggedTask(null)
          setActiveDropTarget(null)
          return
        }
        // Dragging from history to project - add task to project
        const projectId = over.data.current.projectId as number
        const taskId = activeData.task.id as number
        await addTaskToProject(projectId, taskId)
      } else if (
        over &&
        over.data.current?.type === 'project' &&
        activeData?.type === 'project-task'
      ) {
        // Dragging from one project to another project - move task between projects
        const targetProjectId = over.data.current.projectId as number
        const sourceProjectId = activeData.projectId as number
        const taskId = activeData.taskId as number

        // Only move if dropping on a different project
        if (targetProjectId !== sourceProjectId) {
          // Add task to target project (this will update the project_id)
          await addTaskToProject(targetProjectId, taskId)
        }
      } else if (
        over &&
        over.data.current?.type === 'history' &&
        activeData?.type === 'project-task'
      ) {
        // Dragging from project to history - remove task from project
        const projectId = activeData.projectId as number
        const taskId = activeData.taskId as number
        await removeTaskFromProject(projectId, taskId)
      }

      setDraggedTask(null)
      setActiveDropTarget(null)
    },
    [addTaskToProject, removeTaskFromProject, toast, t]
  )

  const handleDragCancel = useCallback(() => {
    setDraggedTask(null)
    setActiveDropTarget(null)
  }, [])

  const contextValue: DndContextValue = {
    isDragging: draggedTask !== null,
    draggedTask,
    activeDropTarget,
  }

  return (
    <DndContext.Provider value={contextValue}>
      <DndKitContext
        sensors={sensors}
        collisionDetection={customCollisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}

        {/* Drag Overlay - shows the dragged item */}
        <DragOverlay dropAnimation={null}>
          {draggedTask && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-primary rounded-lg shadow-lg opacity-90">
              <GripVertical className="w-3.5 h-3.5 text-text-muted" />
              <span className="text-sm text-text-primary truncate max-w-[150px]">
                {draggedTask.title}
              </span>
            </div>
          )}
        </DragOverlay>
      </DndKitContext>
    </DndContext.Provider>
  )
}
