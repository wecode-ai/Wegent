// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useEffect, useState, useCallback } from 'react'
import { Button } from 'antd'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import {
  MagnifyingGlassIcon,
  PlusIcon,
  Cog6ToothIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import TaskListSection from './TaskListSection'
import { useTranslation } from '@/hooks/useTranslation'


export default function TaskSidebar() {
  const { t } = useTranslation('common')
  const router = useRouter()
  const {
    tasks,
    setSelectedTask,
    loadMore,
    hasMore,
    loadingMore,
    searchTerm,
    setSearchTerm,
    searchTasks,
    isSearching,
    isSearchResult
  } = useTaskContext()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [localSearchTerm, setLocalSearchTerm] = useState(searchTerm)

  // Grouping logic
  const groupTasksByDate = React.useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    return {
      today: tasks.filter(task => new Date(task.created_at) >= today),
      thisWeek: tasks.filter(task => {
        const taskDate = new Date(task.created_at);
        return taskDate >= weekAgo && taskDate < today;
      }),
      earlier: tasks.filter(task => new Date(task.created_at) < weekAgo)
    };
  }, [tasks]);

  // New task
  const handleNewAgentClick = () => {
    setSelectedTask(null)
    if (typeof window !== 'undefined') {
      router.replace(paths.task.getHref())
    }
  }

  // Scroll to bottom to load more
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handleScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 10) {
        loadMore()
      }
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [loadMore])

      // Custom debounce function
  const useDebounce = (callback: Function, delay: number) => {
    const timeoutRef = useRef<NodeJS.Timeout | null>(null)
    
    const debouncedFn = useCallback((...args: any[]) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      
      timeoutRef.current = setTimeout(() => {
        callback(...args)
      }, delay)
    }, [callback, delay])
    
    useEffect(() => {
      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
      }
    }, [])
    
    return debouncedFn
  }

      // Use custom debounce to handle search and avoid frequent requests
  const debouncedSearch = useDebounce(async (term: string) => {
    setSearchTerm(term)
    await searchTasks(term)
  }, 500)

      // Handle search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setLocalSearchTerm(value)
    debouncedSearch(value)
  }

      // Clear search
  const handleClearSearch = () => {
    setLocalSearchTerm('')
    setSearchTerm('')
    searchTasks('')
  }

      // No need to cancel debounce, our custom implementation will auto-clean on component unmount

  return (
      <div className="w-56 bg-surface border-r border-border flex flex-col">
        {/* Logo */}
        <div className="p-3">
          <div className="flex justify-start pl-2">
            <Image
              src="/weibo-logo.png"
              alt="Weibo Logo"
              width={24}
              height={24}
              className="object-contain"
            />
          </div>
        </div>

        {/* Search */}
        {/* Search */}
        <div className="p-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
            <input
              type="text"
              value={localSearchTerm}
              onChange={handleSearchChange}
              placeholder={t('tasks.search_placeholder')}
              className="w-full pl-8 pr-8 py-1.5 bg-surface border border-border rounded text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
            />
            {localSearchTerm && (
              <button
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 transform -translate-y-1/2"
              >
                <XMarkIcon className="h-3.5 w-3.5 text-text-muted hover:text-text-primary" />
              </button>
            )}
          </div>
        </div>
        {/* New Task Button */}
        <div className="px-3 mb-3">
          <Button
            onClick={handleNewAgentClick}
            type="primary"
            size="small"
            icon={<PlusIcon className="h-4 w-4 align-middle" />}
            style={{ width: '100%' }}
            className="!text-base"
          >
            {t('tasks.new_task')}
          </Button>
        </div>

        {/* Tasks Section */}
        <div
          className="flex-1 px-3 overflow-y-auto custom-scrollbar"
          ref={scrollRef}
        >
          {isSearching ? (
            <div className="text-center py-8 text-xs text-text-muted">{t('tasks.searching')}</div>
          ) : tasks.length === 0 ? (
            <div className="text-center py-8 text-xs text-text-muted">
              {isSearchResult ? t('tasks.no_search_results') : t('tasks.no_tasks')}
            </div>
          ) : (
            <>
              {isSearchResult ? (
                <TaskListSection
                  tasks={tasks}
                  title={t('tasks.search_results')}
                />
              ) : (
                <>
                  <TaskListSection
                    tasks={groupTasksByDate.today}
                    title={t('tasks.today')}
                  />
                  <TaskListSection
                    tasks={groupTasksByDate.thisWeek}
                    title={t('tasks.this_week')}
                  />
                  <TaskListSection
                    tasks={groupTasksByDate.earlier}
                    title={t('tasks.earlier')}
                  />
                </>
              )}
            </>
          )}
          {loadingMore && (
            <div className="text-center py-2 text-xs text-text-muted">{t('tasks.loading')}</div>
          )}
          {!isSearchResult && !hasMore && tasks.length > 0 && (
            <div className="text-center py-2 text-xs text-text-muted">{t('tasks.no_more_tasks')}</div>
          )}
        </div>
        {/* Settings */}
        <div className="p-3 border-t border-border">
          <Button
            onClick={() => router.push(paths.settings.root.getHref())}
            type="link"
            size="small"
            icon={<Cog6ToothIcon className="h-3.5 w-3.5" />}
            className="!text-text-muted hover:!text-text-primary"
          >
            {t('tasks.settings')}
          </Button>
        </div>
      </div>
    )
}
