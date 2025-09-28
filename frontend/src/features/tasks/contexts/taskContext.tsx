// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { taskApis } from '@/apis/tasks'
import { Task, TaskDetail } from '@/types/api'

type TaskContextType = {
  tasks: Task[]
  taskLoading: boolean
  selectedTask: Task | null
  selectedTaskDetail: TaskDetail | null
  setSelectedTask: (task: Task | null) => void
  refreshTasks: () => void
  refreshSelectedTaskDetail: (isAutoRefresh?: boolean) => void
  loadMore: () => void
  hasMore: boolean
  loadingMore: boolean
  searchTerm: string
  setSearchTerm: (term: string) => void
  searchTasks: (term: string) => Promise<void>
  isSearching: boolean
  isSearchResult: boolean
}

const TaskContext = createContext<TaskContextType | undefined>(undefined)

export const TaskContextProvider = ({ children }: { children: ReactNode }) => {
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskLoading, setTaskLoading] = useState<boolean>(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetail | null>(null)
  const [searchTerm, setSearchTerm] = useState<string>('')
  const [isSearching, setIsSearching] = useState<boolean>(false)
  const [isSearchResult, setIsSearchResult] = useState<boolean>(false)

  // Pagination related
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadedPages, setLoadedPages] = useState([1])
  const limit = 100

  // Batch load specified pages (only responsible for data requests and responses, does not handle loading state)
  const loadPages = async (pagesArr: number[], append = false) => {
    if (pagesArr.length === 0) return { items: [], hasMore: false }
    const requests = pagesArr.map(p => taskApis.getTasks({ page: p, limit }))
    try {
      const results = await Promise.all(requests)
      const allItems = results.flatMap(res => res.items || [])
      const lastPageItems = results[results.length - 1]?.items || []
      return {
        items: allItems,
        hasMore: lastPageItems.length === limit,
        pages: pagesArr
      }
    } catch {
      return { items: [], hasMore: false, pages: [] }
    }
  }

  // Load more
  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const nextPage = (loadedPages[loadedPages.length - 1] || 1) + 1
    const result = await loadPages([nextPage], true)
    setTasks(prev => [...prev, ...result.items])
    setLoadedPages(prev => Array.from(new Set([...prev, ...(result.pages || [])])).sort((a, b) => a - b))
    setHasMore(result.hasMore)
    setLoadingMore(false)
  }

  // Refresh all loaded pages
  const refreshTasks = async () => {
    setTaskLoading(true)
    const result = await loadPages(loadedPages, false)
    setTasks(result.items)
    setLoadedPages(result.pages || [])
    setHasMore(result.hasMore)
    setTaskLoading(false)
  }

  // Initial load
  useEffect(() => {
    refreshTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Automatically refresh all loaded pages every 30 seconds
  // 只有当存在未完成的任务时才进行定时刷新
  useEffect(() => {
    const hasIncompleteTasks = tasks.some(task =>
      task.status !== 'COMPLETED' && task.status !== 'FAILED' && task.status !== 'CANCELLED'
    );

    let interval: NodeJS.Timeout | null = null;

    if (hasIncompleteTasks) {
      interval = setInterval(() => {
        refreshTasks()
      }, 30000)
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [loadedPages, tasks])

  const refreshSelectedTaskDetail = async (isAutoRefresh: boolean = false) => {
    if (!selectedTask) return

    // 只有在自动刷新时才检查任务状态，手动触发时允许查看已完成的任务
    if (isAutoRefresh && selectedTaskDetail &&
      (selectedTaskDetail.status === 'COMPLETED' ||
        selectedTaskDetail.status === 'FAILED' ||
        selectedTaskDetail.status === 'CANCELLED')) {
      return
    }

    try {
      const updatedTaskDetail = await taskApis.getTaskDetail(selectedTask.id)
      setSelectedTaskDetail(updatedTaskDetail)
    } catch (error) {
      console.error('Failed to refresh selected task detail:', error)
    }
  }

  useEffect(() => {
    if (selectedTask) {
      refreshSelectedTaskDetail(false) // 手动选择任务，不是自动刷新
    } else {
      setSelectedTaskDetail(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask])

  // 搜索任务
  const searchTasks = async (term: string) => {
    if (!term.trim()) {
      setIsSearchResult(false)
      return refreshTasks()
    }

    setIsSearching(true)
    setIsSearchResult(true)

    try {
      const result = await taskApis.searchTasks(term, { page: 1, limit: 1000 })
      setTasks(result.items)
      setHasMore(false) // 搜索结果不支持分页加载更多
    } catch (error) {
      console.error('Failed to search tasks:', error)
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <TaskContext.Provider
      value={{
        tasks,
        taskLoading,
        selectedTask,
        selectedTaskDetail,
        setSelectedTask,
        refreshTasks,
        refreshSelectedTaskDetail,
        loadMore,
        hasMore,
        loadingMore,
        searchTerm,
        setSearchTerm,
        searchTasks,
        isSearching,
        isSearchResult
      }}
    >
      {children}
    </TaskContext.Provider>
  )
}
/**
 * useTaskContext must be used within a TaskContextProvider.
 */
export const useTaskContext = () => {
  const context = useContext(TaskContext)
  if (!context) {
    throw new Error('useTaskContext must be used within a TaskContextProvider')
  }
  return context
}