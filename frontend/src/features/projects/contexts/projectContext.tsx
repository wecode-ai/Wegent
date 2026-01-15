// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  ReactNode,
} from 'react'

/**
 * Project task reference - represents a task added to a project
 */
export interface ProjectTask {
  task_id: number
  title: string
  added_at: string
}

/**
 * Project - represents a conversation group/project
 */
export interface Project {
  id: number
  name: string
  description?: string
  tasks: ProjectTask[]
  created_at: string
  updated_at: string
}

/**
 * Project context value interface
 */
interface ProjectContextValue {
  // List of projects
  projects: Project[]
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>

  // Selected project task ID in project section (for highlight control)
  selectedProjectTaskId: number | null
  setSelectedProjectTaskId: (taskId: number | null) => void

  // Set of all task IDs that are in any project (for filtering in history)
  projectTaskIds: Set<number>

  // Add a task to a project
  addTaskToProject: (projectId: number, task: ProjectTask) => void

  // Remove a task from a project
  removeTaskFromProject: (projectId: number, taskId: number) => void
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined)

export { ProjectContext }

export const ProjectContextProvider = ({ children }: { children: ReactNode }) => {
  // Projects state - this would typically be loaded from API
  const [projects, setProjects] = useState<Project[]>([])

  // Track which task is selected in the project section (for highlight control)
  const [selectedProjectTaskId, setSelectedProjectTaskId] = useState<number | null>(null)

  // Compute the set of all task IDs that are in any project
  // This is used to filter these tasks from the history list
  const projectTaskIds = useMemo(() => {
    const ids = new Set<number>()
    projects.forEach(project => {
      project.tasks?.forEach(task => {
        ids.add(task.task_id)
      })
    })
    return ids
  }, [projects])

  // Add a task to a project
  const addTaskToProject = useCallback((projectId: number, task: ProjectTask) => {
    setProjects(prev =>
      prev.map(project => {
        if (project.id === projectId) {
          // Check if task already exists in project
          const taskExists = project.tasks.some(t => t.task_id === task.task_id)
          if (taskExists) {
            return project
          }
          return {
            ...project,
            tasks: [...project.tasks, task],
            updated_at: new Date().toISOString(),
          }
        }
        return project
      })
    )
  }, [])

  // Remove a task from a project
  const removeTaskFromProject = useCallback((projectId: number, taskId: number) => {
    setProjects(prev =>
      prev.map(project => {
        if (project.id === projectId) {
          return {
            ...project,
            tasks: project.tasks.filter(t => t.task_id !== taskId),
            updated_at: new Date().toISOString(),
          }
        }
        return project
      })
    )
  }, [])

  return (
    <ProjectContext.Provider
      value={{
        projects,
        setProjects,
        selectedProjectTaskId,
        setSelectedProjectTaskId,
        projectTaskIds,
        addTaskToProject,
        removeTaskFromProject,
      }}
    >
      {children}
    </ProjectContext.Provider>
  )
}

/**
 * useProjectContext must be used within a ProjectContextProvider.
 */
export const useProjectContext = () => {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error('useProjectContext must be used within a ProjectContextProvider')
  }
  return context
}
