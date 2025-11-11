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
} from '@heroicons/react/24/outline'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { XMarkIcon } from '@heroicons/react/24/outline'
import TaskListSection from './TaskListSection'
import { useTranslation } from '@/hooks/useTranslation'
import MobileSidebar from '@/features/layout/MobileSidebar'

interface TaskSidebarProps {
  isMobileSidebarOpen: boolean
  setIsMobileSidebarOpen: (open: boolean) => void
  pageType?: 'chat' | 'code' 
}

export default function TaskSidebar({
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  pageType = 'chat'
}: TaskSidebarProps) {
  const { t } = useTranslation('common')
  const router = useRouter()
  const {
    tasks,
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

  // Custom debounce
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

  // Debounce search
  const debouncedSearch = useDebounce(async (term: string) => {
    setSearchTerm(term)
    await searchTasks(term)
  }, 500)

  // Search input change
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
    if (typeof window !== 'undefined') {
      // Navigate to the same page type for new task creation
      switch (pageType) {
        case 'code':
          router.replace(paths.code.getHref())
          break
        case 'chat':
        default:
          router.replace(paths.chat.getHref())
          break
      }
    }
    // Close mobile sidebar after navigation
    setIsMobileSidebarOpen(false)
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

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="px-3 pt-2 pb-1">
        <div className="flex items-center justify-start pl-2 gap-2">
          <Image
            src="/weibo-logo.png"
            alt="Weibo Logo"
            width={20}
            height={20}
            className="object-container"
          />
          <span className="text-sm font-medium text-text-primary">
            Wegent
          </span>
        </div>
      </div>

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
          isSearchResult ? (
            <TaskListSection
              tasks={tasks}
              title={t('tasks.search_results')}
              onTaskClick={() => setIsMobileSidebarOpen(false)}
            />
          ) : (
            <>
              <TaskListSection
                tasks={groupTasksByDate.today}
                title={t('tasks.today')}
                onTaskClick={() => setIsMobileSidebarOpen(false)}
              />
              <TaskListSection
                tasks={groupTasksByDate.thisWeek}
                title={t('tasks.this_week')}
                onTaskClick={() => setIsMobileSidebarOpen(false)}
              />
              <TaskListSection
                tasks={groupTasksByDate.earlier}
                title={t('tasks.earlier')}
                onTaskClick={() => setIsMobileSidebarOpen(false)}
              />
            </>
          )
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
          onClick={() => {
            router.push(paths.settings.root.getHref())
            setIsMobileSidebarOpen(false)
          }}
          type="link"
          size="small"
          icon={<Cog6ToothIcon className="h-3.5 w-3.5" />}
          className="!text-text-muted hover:!text-text-primary"
        >
          {t('tasks.settings')}
        </Button>
      </div>
    </>
  )

  return (
    <>
      {/* Desktop Sidebar - Hidden on mobile, width controlled by parent ResizableSidebar */}
      <div className="hidden lg:flex lg:flex-col lg:bg-surface w-full h-full">
        {sidebarContent}
      </div>

      {/* Mobile Sidebar */}
      <MobileSidebar
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
        title={t('navigation.tasks')}
      >
        {sidebarContent}
      </MobileSidebar>

    </>
  )
}

