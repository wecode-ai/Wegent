// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useSearchParams } from 'next/navigation'
import { ProjectWithTasks, ProjectTask } from '@/types/api'
import { projectApis, CreateProjectRequest, UpdateProjectRequest } from '@/apis/projects'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ApiError } from '@/apis/client'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { useUser } from '@/features/common/UserContext'
import { useSocket } from '@/contexts/SocketContext'
import { dispatchProjectDeletedEvent, dispatchProjectTasksChangedEvent } from '../events'
import { getFirstSearchParam } from '@/lib/search-params'
import { taskApis } from '@/apis/tasks'
import { useProjectTaskPages, ProjectTaskPageState } from './useProjectTaskPages'

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
  projectTaskPages: Record<number, ProjectTaskPageState>
  loadProjectTasks: (projectId: number, loadMore?: boolean) => Promise<void>
  loadAllProjectTasks: (projectId: number) => Promise<void>

  // UI state
  toggleProjectExpanded: (projectId: number) => void
  expandedProjects: Set<number>
  isProjectSectionCollapsed: boolean
  setProjectSectionCollapsed: React.Dispatch<React.SetStateAction<boolean>>

  // Highlight control - track which task is selected in project section
  selectedProjectTaskId: number | null
  selectedProjectTask: ProjectTask | null
  setSelectedProjectTaskId: (taskId: number | null) => void

  // IDs in loaded project pages.
  projectTaskIds: Set<number>

  // Feature flag: whether workspace projects are enabled for current user
  isWorkspaceEnabled: boolean
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined)

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('projects')
  const { toast } = useToast()
  const { user } = useUser()
  const { isConnected, registerTaskHandlers } = useSocket()
  const searchParams = useSearchParams()
  const runtimeConfig = getRuntimeConfigSync()
  const enableProjectWorkspace = useMemo(() => {
    if (!runtimeConfig.enableProjectWorkspace) return false
    const whitelist = runtimeConfig.projectWorkspaceWhitelist
    if (!whitelist) return true
    const allowedUsers = whitelist
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    if (allowedUsers.length === 0) return true
    return allowedUsers.includes(user?.user_name || '')
  }, [
    runtimeConfig.enableProjectWorkspace,
    runtimeConfig.projectWorkspaceWhitelist,
    user?.user_name,
  ])

  const [projects, setProjects] = useState<ProjectWithTasks[]>([])
  const projectsRef = useRef<ProjectWithTasks[]>([])
  const accountKey = user ? String(user.id ?? user.user_name) : null
  const accountRef = useRef(accountKey)
  const refreshRequestRef = useRef(0)
  accountRef.current = accountKey
  const updateProjects = useCallback(
    (update: (current: ProjectWithTasks[]) => ProjectWithTasks[]) => {
      const next = update(projectsRef.current)
      projectsRef.current = next
      setProjects(next)
    },
    []
  )
  const {
    projectTaskPages,
    loadProjectTasks,
    loadAllProjectTasks,
    resetProjectTasks,
    refreshProjectTaskHead,
  } = useProjectTaskPages(accountKey, projectsRef, updateProjects)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set())
  const [isProjectSectionCollapsed, setProjectSectionCollapsed] = useState(false)

  // Track which task is selected in the project section (for highlight control)
  const [selectedProjectTaskId, setSelectedProjectTaskId] = useState<number | null>(null)

  const routeTaskIdValue = getFirstSearchParam(searchParams, ['taskId', 'task_id', 'taskid'])
  const routeTaskId = routeTaskIdValue ? Number(routeTaskIdValue) : null
  const routeProjectIdValue = getFirstSearchParam(searchParams, [
    'projectId',
    'conversationGroupId',
  ])
  const routeProjectId = routeProjectIdValue ? Number(routeProjectIdValue) : null
  const [routeAssociation, setRouteAssociation] = useState<{
    account: string | null
    taskId: number
    projectId: number | null
    task?: ProjectTask | null
  } | null>(null)
  const routeRequestRef = useRef(0)
  const metadataAccountRef = useRef<string | null>(null)
  const routeRef = useRef({ taskId: routeTaskId, projectId: routeProjectId })
  routeRef.current = { taskId: routeTaskId, projectId: routeProjectId }

  const resolveSelectedTask = useCallback(async (refresh: boolean = false) => {
    const taskId = routeRef.current.taskId
    const account = accountRef.current
    if (!taskId || !Number.isFinite(taskId) || !account) return
    const request = ++routeRequestRef.current
    const cachedProject = projectsRef.current.find(project =>
      project.tasks.some(task => task.task_id === taskId)
    )
    if (!refresh && cachedProject) {
      setRouteAssociation({
        account,
        taskId,
        projectId: cachedProject.id,
        task: cachedProject.tasks.find(task => task.task_id === taskId),
      })
      return
    }
    const isCurrent = () =>
      routeRequestRef.current === request &&
      accountRef.current === account &&
      routeRef.current.taskId === taskId
    try {
      const task = await taskApis.getTaskDetail(taskId)
      if (!isCurrent()) return
      setRouteAssociation({
        account,
        taskId,
        projectId: task.project_id ?? null,
        task: task.project_id
          ? {
              task_id: task.id,
              task_title: task.title,
              task_status: task.status,
              project_id: task.project_id,
              device_id: task.device_id,
              is_group_chat: task.is_group_chat ?? false,
              updated_at: task.updated_at,
            }
          : null,
      })
    } catch (err) {
      if (!isCurrent()) return
      if (err instanceof ApiError && err.status === 404) {
        setRouteAssociation({ account, taskId, projectId: null })
      } else console.error('[ProjectContext] Failed to resolve task project:', err)
    }
  }, [])

  // Task history also uses task.project_id for associations outside loaded pages.
  const projectTaskIds = useMemo(() => {
    const ids = new Set<number>()
    projects.forEach(project => {
      if (!enableProjectWorkspace && project.config?.mode === 'workspace') {
        return
      }
      project.tasks?.forEach(task => {
        ids.add(task.task_id)
      })
    })
    return ids
  }, [projects, enableProjectWorkspace])

  // Fetch projects
  const refreshProjects = useCallback(
    async (preserveTaskPages: boolean = false) => {
      const request = ++refreshRequestRef.current
      const requestAccount = accountRef.current
      if (!requestAccount) return
      const isCurrent = () =>
        request === refreshRequestRef.current && accountRef.current === requestAccount
      const preserveTasks = preserveTaskPages && metadataAccountRef.current === requestAccount
      if (!preserveTasks) {
        resetProjectTasks()
        setIsLoading(true)
      }
      setError(null)
      try {
        const response = await projectApis.getProjects(false)
        if (!isCurrent()) return
        const preserveExpansion = metadataAccountRef.current === requestAccount
        const knownProjects = new Map(projectsRef.current.map(project => [project.id, project]))
        updateProjects(() =>
          response.items.map(project => ({
            ...project,
            tasks: preserveTasks ? (knownProjects.get(project.id)?.tasks ?? []) : [],
          }))
        )
        resetProjectTasks(
          preserveTasks ? new Set(response.items.map(project => project.id)) : undefined
        )

        // Preserve current-account choices; use server defaults for new groups.
        setExpandedProjects(previous => {
          const expanded = new Set<number>()
          response.items.forEach(project => {
            const isExpanded =
              preserveExpansion && knownProjects.has(project.id)
                ? previous.has(project.id)
                : project.is_expanded
            if (isExpanded) expanded.add(project.id)
          })
          return expanded
        })
        metadataAccountRef.current = requestAccount
        if (!preserveTasks) await resolveSelectedTask(true)
      } catch (err) {
        if (!isCurrent()) return
        const message = err instanceof Error ? err.message : 'Failed to load projects'
        setError(message)
        console.error('[ProjectContext] Failed to load projects:', err)
      } finally {
        if (isCurrent()) setIsLoading(false)
      }
    },
    [resetProjectTasks, resolveSelectedTask, updateProjects]
  )

  useEffect(() => {
    if (!isConnected) return
    return registerTaskHandlers({
      onTaskCreated: task => {
        if (!task.project_id) return
        void refreshProjectTaskHead(task.project_id)
        void refreshProjects(true)
      },
    })
  }, [isConnected, registerTaskHandlers, refreshProjects, refreshProjectTaskHead])

  // Create project
  const createProject = useCallback(
    async (data: CreateProjectRequest): Promise<ProjectWithTasks | null> => {
      try {
        const newProject = await projectApis.createProject(data)
        await refreshProjects()
        toast({
          title: t('toast.createSuccess'),
          description: t('toast.createSuccessDesc', { name: newProject.name }),
        })
        return projectsRef.current.find(p => p.id === newProject.id) || null
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
    [refreshProjects, toast, t]
  )

  // Update project
  const updateProject = useCallback(
    async (id: number, data: UpdateProjectRequest): Promise<ProjectWithTasks | null> => {
      try {
        await projectApis.updateProject(id, data)
        // Update local state
        updateProjects(prev => prev.map(p => (p.id === id ? { ...p, ...data } : p)))
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
    [toast, t, projects, updateProjects]
  )

  // Delete project
  const deleteProject = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        await projectApis.deleteProject(id)
        // Remove from local state
        updateProjects(prev => prev.filter(p => p.id !== id))
        resetProjectTasks(new Set(projectsRef.current.map(project => project.id)))
        dispatchProjectDeletedEvent(id)
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
    [toast, t, resetProjectTasks, updateProjects]
  )

  // Add task to project
  const addTaskToProject = useCallback(
    async (projectId: number, taskId: number): Promise<ProjectTask | null> => {
      const requestAccount = accountRef.current
      try {
        const response = await projectApis.addTaskToProject(projectId, taskId)
        if (accountRef.current !== requestAccount) return null
        if (routeTaskId === taskId) {
          routeRequestRef.current += 1
          setRouteAssociation({
            account: requestAccount,
            taskId,
            projectId,
            task: response.project_task,
          })
        }
        dispatchProjectTasksChangedEvent()
        await refreshProjects()
        if (accountRef.current !== requestAccount) return null
        toast({
          title: t('toast.addTaskSuccess'),
        })
        return response.project_task
      } catch (err) {
        if (accountRef.current !== requestAccount) return null
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
    [toast, t, refreshProjects, routeTaskId]
  )

  // Remove task from project
  const removeTaskFromProject = useCallback(
    async (projectId: number, taskId: number): Promise<boolean> => {
      const requestAccount = accountRef.current
      try {
        await projectApis.removeTaskFromProject(projectId, taskId)
        if (accountRef.current !== requestAccount) return false
        if (routeTaskId === taskId) {
          routeRequestRef.current += 1
          setRouteAssociation({ account: requestAccount, taskId, projectId: null })
        }
        dispatchProjectTasksChangedEvent()
        await refreshProjects()
        if (accountRef.current !== requestAccount) return false
        toast({
          title: t('toast.removeTaskSuccess'),
        })
        return true
      } catch (err) {
        if (accountRef.current !== requestAccount) return false
        const message = err instanceof Error ? err.message : 'Failed to remove task from project'
        // Only show error toast for unexpected errors, not for 404 (task not found)
        // Check both ApiError status code and error message for "not found" (case-insensitive)
        const isNotFoundError =
          (err instanceof ApiError && err.status === 404) ||
          (err instanceof Error && err.message.toLowerCase().includes('not found')) ||
          // Also check for status property on plain objects (in case instanceof fails)
          (typeof err === 'object' &&
            err !== null &&
            'status' in err &&
            (err as { status: number }).status === 404)
        if (isNotFoundError) {
          // Silently ignore "not found" errors - task is already removed from project
          if (routeTaskId === taskId) {
            routeRequestRef.current += 1
            setRouteAssociation({ account: requestAccount, taskId, projectId: null })
          }
          dispatchProjectTasksChangedEvent()
          await refreshProjects()
          return true
        }
        toast({
          title: t('toast.removeTaskFailed'),
          description: message,
          variant: 'destructive',
        })
        console.error('[ProjectContext] Failed to remove task from project:', err)
        return false
      }
    },
    [toast, t, refreshProjects, routeTaskId]
  )

  // Toggle project expanded state
  const toggleProjectExpanded = useCallback(
    (projectId: number) => {
      const nextIsExpanded = !expandedProjects.has(projectId)

      setExpandedProjects(prev => {
        const next = new Set(prev)
        if (nextIsExpanded) {
          next.add(projectId)
        } else {
          next.delete(projectId)
        }
        return next
      })

      // Keep the project model aligned so refreshes and subsequent toggles
      // persist the visible state instead of reusing a stale server value.
      updateProjects(prev =>
        prev.map(project =>
          project.id === projectId ? { ...project, is_expanded: nextIsExpanded } : project
        )
      )

      // Persist to server
      const project = projects.find(p => p.id === projectId)
      if (project) {
        projectApis
          .updateProject(projectId, {
            is_expanded: nextIsExpanded,
          })
          .catch(err => {
            console.error('[ProjectContext] Failed to persist expanded state:', err)
          })
      }
    },
    [expandedProjects, projects, updateProjects]
  )

  // Account changes invalidate cached metadata and every in-flight page request.
  useEffect(() => {
    updateProjects(() => [])
    metadataAccountRef.current = null
    resetProjectTasks()
    setExpandedProjects(new Set())
    setSelectedProjectTaskId(null)
    setError(null)
    setIsLoading(false)
    if (accountKey) void refreshProjects()
    return () => {
      refreshRequestRef.current += 1
    }
  }, [accountKey, refreshProjects, resetProjectTasks, updateProjects])

  // A deep-linked task may be outside every loaded page. Resolve its association
  // once per route instead of downloading complete groups to locate it.
  useEffect(() => {
    setRouteAssociation(null)
    routeRequestRef.current += 1
    if (metadataAccountRef.current === accountKey) void resolveSelectedTask()
    return () => {
      routeRequestRef.current += 1
    }
  }, [accountKey, routeTaskId, routeProjectId, resolveSelectedTask])

  const activeProjectId = useMemo(() => {
    if (!routeTaskId || !Number.isFinite(routeTaskId)) return null
    const hasResolvedAssociation =
      routeAssociation?.account === accountKey && routeAssociation.taskId === routeTaskId
    const resolvedProjectId = hasResolvedAssociation ? routeAssociation.projectId : routeProjectId
    const activeProject = resolvedProjectId
      ? projects.find(project => project.id === resolvedProjectId)
      : hasResolvedAssociation
        ? undefined
        : projects.find(project =>
            project.tasks.some(projectTask => projectTask.task_id === routeTaskId)
          )
    return activeProject?.id ?? null
  }, [accountKey, projects, routeAssociation, routeTaskId, routeProjectId])

  // Reveal the group when entering a task or resolving its association, while
  // preserving manual collapse across page loads and metadata updates.
  useEffect(() => {
    if (!activeProjectId || !routeTaskId) {
      setSelectedProjectTaskId(null)
      return
    }

    setSelectedProjectTaskId(routeTaskId)
    setProjectSectionCollapsed(false)
    setExpandedProjects(previous => {
      if (previous.has(activeProjectId)) return previous
      const next = new Set(previous)
      next.add(activeProjectId)
      return next
    })
  }, [accountKey, activeProjectId, routeTaskId])

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
    projectTaskPages,
    loadProjectTasks,
    loadAllProjectTasks,
    toggleProjectExpanded,
    expandedProjects,
    isProjectSectionCollapsed,
    setProjectSectionCollapsed,
    selectedProjectTaskId,
    selectedProjectTask:
      routeAssociation?.account === accountKey &&
      routeAssociation.taskId === routeTaskId &&
      projects.some(project => project.id === routeAssociation.projectId)
        ? (routeAssociation.task ?? null)
        : null,
    setSelectedProjectTaskId,
    projectTaskIds,
    isWorkspaceEnabled: enableProjectWorkspace,
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
