// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { useProjectContext, ProjectTask, Project } from '../contexts/projectContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { MessageSquare } from 'lucide-react'

interface ProjectSectionProps {
  project: Project
  onTaskClick?: () => void
  isCollapsed?: boolean
}

export default function ProjectSection({
  project,
  onTaskClick,
  isCollapsed = false,
}: ProjectSectionProps) {
  const router = useRouter()
  const { selectedProjectTaskId, setSelectedProjectTaskId } = useProjectContext()
  const { setSelectedTask, markTaskAsViewed } = useTaskContext()
  const { clearAllStreams } = useChatStreamContext()

  // Handle task click in project section
  const handleTaskClick = (projectTask: ProjectTask) => {
    // Clear all stream states when switching tasks
    clearAllStreams()

    // Mark task as viewed
    markTaskAsViewed(projectTask.task_id, 'COMPLETED')

    // Set project task as selected (for project section highlight)
    setSelectedProjectTaskId(projectTask.task_id)

    // Clear TaskContext's selectedTask to remove highlight from history section
    setSelectedTask(null)

    // Navigate to chat page with task ID
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams()
      params.set('taskId', String(projectTask.task_id))
      router.push(`${paths.chat.getHref()}?${params.toString()}`)

      if (onTaskClick) {
        onTaskClick()
      }
    }
  }

  if (!project.tasks || project.tasks.length === 0) {
    return null
  }

  return (
    <div className={`mb-2 w-full ${isCollapsed ? 'px-2' : ''}`}>
      {/* Project name as header */}
      {!isCollapsed && (
        <h3 className="text-sm text-text-primary tracking-wide mb-1 px-2 font-medium">
          {project.name}
        </h3>
      )}
      <div className="space-y-0.5">
        {project.tasks.map(projectTask => {
          const isSelected = selectedProjectTaskId === projectTask.task_id

          return (
            <div
              key={projectTask.task_id}
              className={`flex items-center gap-2 py-1.5 px-3 h-8 rounded-xl cursor-pointer ${
                isSelected ? 'bg-primary/10' : 'hover:bg-hover'
              }`}
              onClick={() => handleTaskClick(projectTask)}
            >
              {/* Task type icon on the left */}
              <div className="flex-shrink-0">
                <MessageSquare className="w-3.5 h-3.5 text-text-primary" />
              </div>

              {/* Task title in the middle */}
              <p className="flex-1 min-w-0 text-sm text-text-primary leading-tight truncate m-0">
                {projectTask.title}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
