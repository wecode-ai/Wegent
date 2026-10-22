// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { projectApis } from '@/apis/projects'
import type { ProjectWithTasks } from '@/types/api'

export interface ProjectTaskPageState {
  loading: boolean
  loaded: boolean
  hasMore: boolean
  error?: string
}

interface PageState extends ProjectTaskPageState {
  nextCursor: string | null
}

export function useProjectTaskPages(
  accountKey: string | null,
  projectsRef: RefObject<ProjectWithTasks[]>,
  updateProjects: (update: (projects: ProjectWithTasks[]) => ProjectWithTasks[]) => void
) {
  const [projectTaskPages, setProjectTaskPages] = useState<Record<number, PageState>>({})
  const pagesRef = useRef<Record<number, PageState>>({})
  const requestsRef = useRef(new Map<number, symbol>())
  const headRequestsRef = useRef(new Map<number, symbol>())
  const accountRef = useRef(accountKey)
  const mountedRef = useRef(true)
  accountRef.current = accountKey

  const resetProjectTasks = useCallback((retainedProjectIds?: Set<number>) => {
    for (const requests of [requestsRef.current, headRequestsRef.current]) {
      for (const projectId of requests.keys()) {
        if (!retainedProjectIds?.has(projectId)) requests.delete(projectId)
      }
    }
    pagesRef.current = Object.fromEntries(
      Object.entries(pagesRef.current).filter(([projectId]) =>
        retainedProjectIds?.has(Number(projectId))
      )
    )
    setProjectTaskPages(pagesRef.current)
  }, [])

  useEffect(() => {
    const requests = requestsRef.current
    const headRequests = headRequestsRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requests.clear()
      headRequests.clear()
    }
  }, [])

  const loadProjectTasks = useCallback(
    async (projectId: number, loadMore: boolean = false): Promise<void> => {
      const project = projectsRef.current.find(item => item.id === projectId)
      const previous = pagesRef.current[projectId]
      if (!accountRef.current || !project || requestsRef.current.has(projectId)) return
      if (previous?.loaded && (!loadMore || !previous.hasMore)) return

      const cursor = previous?.nextCursor ?? undefined
      const request = Symbol()
      const requestAccount = accountRef.current
      const isCurrent = () =>
        mountedRef.current &&
        accountRef.current === requestAccount &&
        requestsRef.current.get(projectId) === request
      const publish = (state: PageState) => {
        pagesRef.current = { ...pagesRef.current, [projectId]: state }
        setProjectTaskPages(pagesRef.current)
      }

      requestsRef.current.set(projectId, request)
      publish({
        nextCursor: previous?.nextCursor ?? null,
        loaded: previous?.loaded ?? false,
        hasMore: previous?.hasMore ?? project.task_count > 0,
        loading: true,
      })

      try {
        const response = await projectApis.getProjectTasks(projectId, 50, cursor)
        if (!isCurrent()) return
        updateProjects(projects =>
          projects.map(item => {
            if (item.id !== projectId) return item
            const tasks = new Map(
              (previous?.loaded ? item.tasks : []).map(task => [task.task_id, task])
            )
            response.items.forEach(task => tasks.set(task.task_id, task))
            return { ...item, tasks: [...tasks.values()], task_count: response.total }
          })
        )
        publish({
          nextCursor: response.next_cursor,
          loading: false,
          loaded: true,
          hasMore: response.has_more,
        })
      } catch (err) {
        if (!isCurrent()) return
        publish({
          nextCursor: previous?.nextCursor ?? null,
          loaded: previous?.loaded ?? false,
          hasMore: previous?.hasMore ?? project.task_count > 0,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load project tasks',
        })
      } finally {
        if (isCurrent()) requestsRef.current.delete(projectId)
      }
    },
    [projectsRef, updateProjects]
  )

  const refreshProjectTaskHead = useCallback(
    async (projectId: number): Promise<void> => {
      const account = accountRef.current
      if (!account || !pagesRef.current[projectId]?.loaded) return
      const request = Symbol()
      headRequestsRef.current.set(projectId, request)
      const isCurrent = () =>
        mountedRef.current &&
        accountRef.current === account &&
        headRequestsRef.current.get(projectId) === request
      try {
        const response = await projectApis.getProjectTasks(projectId, 50)
        if (!isCurrent()) return
        updateProjects(projects =>
          projects.map(project => {
            if (project.id !== projectId) return project
            const tasks = new Map(response.items.map(task => [task.task_id, task]))
            project.tasks.forEach(task => {
              if (!tasks.has(task.task_id)) tasks.set(task.task_id, task)
            })
            return { ...project, tasks: [...tasks.values()], task_count: response.total }
          })
        )
        // Head refreshes leave the latest pagination cursor and end marker intact.
      } catch (err) {
        if (isCurrent()) console.error('[ProjectContext] Failed to refresh project tasks:', err)
      } finally {
        if (isCurrent()) headRequestsRef.current.delete(projectId)
      }
    },
    [updateProjects]
  )

  return { projectTaskPages, loadProjectTasks, resetProjectTasks, refreshProjectTaskHead }
}
