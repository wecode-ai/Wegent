// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FolderOpen, ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useProjectContext } from '../contexts/projectContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import type { ProjectWithTasks, Task } from '@/types/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'

interface ProjectSelectorTabProps {
  projectId: number
  disabled?: boolean
}

export function ProjectSelectorTab({ projectId, disabled }: ProjectSelectorTabProps) {
  const router = useRouter()
  const { projects } = useProjectContext()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()

  const currentProject = projects.find(p => p.id === projectId)
  const workspaceProjects = projects.filter(p => p.config?.mode === 'workspace')

  const handleSwitchProject = (project: ProjectWithTasks) => {
    if (project.id === projectId) return
    clearAllStreams()
    setSelectedTask(null as unknown as Task)
    const params = new URLSearchParams()
    params.set('projectId', String(project.id))
    const deviceId = project.config?.execution?.deviceId
    if (deviceId) {
      params.set('deviceId', deviceId)
    }
    router.push(`/devices/chat?${params.toString()}`)
  }

  if (!currentProject) return null

  if (disabled) {
    return (
      <div
        data-testid="project-selector-tab"
        className="flex items-center gap-1 min-w-0 rounded-[24px] pl-2.5 pr-3 py-2.5 h-9 bg-transparent text-text-primary opacity-80 cursor-not-allowed"
      >
        <FolderOpen className="w-4 h-4 flex-shrink-0" />
        <span className="max-w-[120px] truncate text-xs min-w-0">{currentProject.name}</span>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="project-selector-tab"
        className="flex items-center gap-1 min-w-0 rounded-[24px] pl-2.5 pr-3 py-2.5 h-9 bg-transparent text-text-primary hover:bg-hover transition-colors focus:outline-none focus:ring-0"
      >
        <FolderOpen className="w-4 h-4 flex-shrink-0" />
        <span className="max-w-[120px] truncate text-xs min-w-0">{currentProject.name}</span>
        <ChevronDown className="w-2.5 h-2.5 flex-shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {workspaceProjects.map(project => (
          <DropdownMenuItem
            key={project.id}
            onClick={() => handleSwitchProject(project)}
            className={project.id === projectId ? 'bg-primary/10' : ''}
          >
            <FolderOpen className="w-3.5 h-3.5 mr-2 text-primary" />
            <span className="truncate">{project.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
