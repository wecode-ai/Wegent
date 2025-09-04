// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { taskApis } from '@/apis/tasks'
import { Task } from '@/types/api'

type TaskContextType = {
  tasks: Task[]
  taskLoading: boolean
  selectedTask: Task | null
  setSelectedTask: (task: Task | null) => void
  refreshTasks: () => void
  loadMore: () => void
  hasMore: boolean
  loadingMore: boolean
}

const TaskContext = createContext<TaskContextType | undefined>(undefined)

export const TaskContextProvider = ({ children }: { children: ReactNode }) => {
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskLoading, setTaskLoading] = useState<boolean>(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)

  // 分页相关
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadedPages, setLoadedPages] = useState([1])
  const limit = 100

  // 批量加载指定页（只负责数据请求和返回，不处理 loading 状态）
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

  // 加载更多
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

  // 刷新所有已加载页
  const refreshTasks = async () => {
    setTaskLoading(true)
    const result = await loadPages(loadedPages, false)
    setTasks(result.items)
    setLoadedPages(result.pages || [])
    setHasMore(result.hasMore)
    setTaskLoading(false)
  }

  // 首次加载
  useEffect(() => {
    refreshTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 定时每 30 秒自动刷新所有已加载页
  useEffect(() => {
    const interval = setInterval(() => {
      refreshTasks()
    }, 30000)
    return () => {
      clearInterval(interval)
    }
  }, [loadedPages])

  return (
    <TaskContext.Provider
      value={{
        tasks,
        taskLoading,
        selectedTask,
        setSelectedTask,
        refreshTasks,
        loadMore,
        hasMore,
        loadingMore,
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