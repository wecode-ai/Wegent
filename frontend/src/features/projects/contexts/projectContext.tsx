// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react'
import { ProjectWithTasks, ProjectTask } from '@/types/api'
import { projectApis, CreateProjectRequest, UpdateProjectRequest } from '@/apis/projects'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

interface ProjectContextValue {
  // Data
  projects: ProjectWithTasks[]
  isLoading: boolean
  error: string | null

  // Operations
  refreshProjects: () => Promise<void>
  createProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks | null>
  updateProject: (id: number, data: UpdateProjectRequest) => Promise<ProjectWithTasks | null>
  deleteProject: (id: number) => Promise<boolean>

  // Task associations
  addTaskToProject: (projectId: number, taskId: number) => Promise<ProjectTask | null>
  removeTaskFromProject: (projectId: number, taskId: number) => Promise<boolean>

  // UI state
  toggleProjectExpanded: (projectId: number) => void
  expandedProjects: Set<number>

  // Highlight control - track which task is selected in project section
  selectedProjectTaskId: number | null
  setSelectedProjectTaskId: (taskId: number | null) => void

  // Computed set of all task IDs in projects (for filtering in history list)
  projectTaskIds: Set<number>
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined)

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('projects')
  const { toast } = useToast()

  const [projects, setProjects] = useState<ProjectWithTasks[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set())

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

  // Fetch projects
  const refreshProjects = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await projectApis.getProjects(true)
      setProjects(response.items)

      // Initialize expanded state from server
      const expanded = new Set<number>()
      response.items.forEach(project => {
        if (project.is_expanded) {
          expanded.add(project.id)
        }
      })
      setExpandedProjects(expanded)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load projects'
      setError(message)
      console.error('[ProjectContext] Failed to load projects:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Create project
  const createProject = useCallback(
    async (data: CreateProjectRequest): Promise<ProjectWithTasks | null> => {
      try {
        const newProject = await projectApis.createProject(data)
        // Refresh to get the full project with tasks
        await refreshProjects()
        toast({
          title: t('toast.createSuccess'),
          description: t('toast.createSuccessDesc', { name: newProject.name }),
        })
        return projects.find(p => p.id === newProject.id) || null
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create project'
        toast({
          title: t('toast.createFailed'),
          description: message,
          variant: 'destructive',
        })
        console.error('[ProjectContext] Failed to create project:', err)
        return null
      }
    },
    [refreshProjects, toast, t, projects]
  )

  // Update project
  const updateProject = useCallback(
    async (id: number, data: UpdateProjectRequest): Promise<ProjectWithTasks | null> => {
      try {
        await projectApis.updateProject(id, data)
        // Update local state
        setProjects(prev => prev.map(p => (p.id === id ? { ...p, ...data } : p)))
        toast({
          title: t('toast.updateSuccess'),
        })
        return projects.find(p => p.id === id) || null
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update project'
        toast({
          title: t('toast.updateFailed'),
          description: message,
          variant: 'destructive',
        })
        console.error('[ProjectContext] Failed to update project:', err)
        return null
      }
    },
    [toast, t, projects]
  )

  // Delete project
  const deleteProject = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        await projectApis.deleteProject(id)
        // Remove from local state
        setProjects(prev => prev.filter(p => p.id !== id))
        toast({
          title: t('toast.deleteSuccess'),
        })
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete project'
        toast({
          title: t('toast.deleteFailed'),
          description: message,
          variant: 'destructive',
        })
        console.error('[ProjectContext] Failed to delete project:', err)
        return false
      }
    },
    [toast, t]
  )

  // Add task to project
  const addTaskToProject = useCallback(
    async (projectId: number, taskId: number): Promise<ProjectTask | null> => {
      try {
        const response = await projectApis.addTaskToProject(projectId, taskId)
        // Update local state - add to new project and remove from any other project
        setProjects(prev =>
          prev.map(p => {
            if (p.id === projectId) {
              // Add task to target project (if not already there)
              const alreadyExists = p.tasks.some(t => t.task_id === taskId)
              if (alreadyExists) {
                return p
              }
              return {
                ...p,
                tasks: [...p.tasks, response.project_task],
                task_count: p.task_count + 1,
              }
            } else {
              // Remove task from other projects (for moving between projects)
              const hadTask = p.tasks.some(t => t.task_id === taskId)
              if (hadTask) {
                return {
                  ...p,
                  tasks: p.tasks.filter(t => t.task_id !== taskId),
                  task_count: Math.max(0, p.task_count - 1),
                }
              }
            }
            return p
          })
        )
        toast({
          title: t('toast.addTaskSuccess'),
        })
        return response.project_task
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add task to project'
        toast({
          title: t('toast.addTaskFailed'),
          description: message,
          variant: 'destructive',
        })
        console.error('[ProjectContext] Failed to add task to project:', err)
        return null
      }
    },
    [toast, t]
  )

  // Remove task from project
  const removeTaskFromProject = useCallback(
    async (projectId: number, taskId: number): Promise<boolean> => {
      try {
        await projectApis.removeTaskFromProject(projectId, taskId)
        // Update local state
        setProjects(prev =>
          prev.map(p => {
            if (p.id === projectId) {
              return {
                ...p,
                tasks: p.tasks.filter(t => t.task_id !== taskId),
                task_count: Math.max(0, p.task_count - 1),
              }
            }
            return p
          })
        )
        toast({
          title: t('toast.removeTaskSuccess'),
        })
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove task from project'
        toast({
          title: t('toast.removeTaskFailed'),
          description: message,
          variant: 'destructive',
        })
        console.error('[ProjectContext] Failed to remove task from project:', err)
        return false
      }
    },
    [toast, t]
  )

  // Toggle project expanded state
  const toggleProjectExpanded = useCallback(
    (projectId: number) => {
      setExpandedProjects(prev => {
        const next = new Set(prev)
        if (next.has(projectId)) {
          next.delete(projectId)
        } else {
          next.add(projectId)
        }
        return next
      })

      // Persist to server
      const project = projects.find(p => p.id === projectId)
      if (project) {
        projectApis
          .updateProject(projectId, {
            is_expanded: !project.is_expanded,
          })
          .catch(err => {
            console.error('[ProjectContext] Failed to persist expanded state:', err)
          })
      }
    },
    [projects]
  )

  // Load projects on mount
  useEffect(() => {
    refreshProjects()
  }, [refreshProjects])

  const value: ProjectContextValue = {
    projects,
    isLoading,
    error,
    refreshProjects,
    createProject,
    updateProject,
    deleteProject,
    addTaskToProject,
    removeTaskFromProject,
    toggleProjectExpanded,
    expandedProjects,
    selectedProjectTaskId,
    setSelectedProjectTaskId,
    projectTaskIds,
  }

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProjectContext() {
  const context = useContext(ProjectContext)
  if (context === undefined) {
    throw new Error('useProjectContext must be used within a ProjectProvider')
  }
  return context
}
