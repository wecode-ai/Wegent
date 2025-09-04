// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useEffect } from 'react'
import { Button, Listbox } from '@headlessui/react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import {
  MagnifyingGlassIcon,
  PlusIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import TaskListSection from './TaskListSection'



export default function TaskSidebar() {
  const router = useRouter()
  const { tasks, setSelectedTask, loadMore, hasMore, loadingMore } = useTaskContext()
  const scrollRef = useRef<HTMLDivElement>(null)

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

  return (
      <div className="w-56 bg-[#161b22] border-r border-[#21262d] flex flex-col">
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
        <div className="p-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search task..."
              className="w-full pl-8 pr-2 py-1.5 bg-[#161b22] border border-[#30363d] rounded text-xs text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
            />
          </div>
        </div>

        {/* New Task Button */}
        <div className="px-3 mb-3">
          <Button
            onClick={handleNewAgentClick}
            className="w-full flex items-center justify-center px-2.5 py-1.5 text-xs font-medium rounded transition-colors duration-200 text-gray-900"
            style={{ backgroundColor: 'rgb(112,167,215)' }}
          >
            <PlusIcon className="h-3.5 w-3.5 mr-1.5" />
            New Task
          </Button>
        </div>

        {/* Tasks Section */}
        {/* Tasks Section */}
        <div
          className="flex-1 px-3 overflow-y-auto custom-scrollbar"
          ref={scrollRef}
        >
          {tasks.length === 0 ? (
            <div className="text-center py-8 text-xs text-gray-400">No tasks</div>
          ) : (
            <>
              <TaskListSection
                tasks={groupTasksByDate.today}
                title="Today"
              />
              <TaskListSection
                tasks={groupTasksByDate.thisWeek}
                title="This Week"
              />
              <TaskListSection
                tasks={groupTasksByDate.earlier}
                title="Earlier"
              />
            </>
          )}
          {loadingMore && (
            <div className="text-center py-2 text-xs text-gray-400">Loading...</div>
          )}
          {!hasMore && tasks.length > 0 && (
            <div className="text-center py-2 text-xs text-gray-400">No more tasks</div>
          )}
        </div>
        {/* Settings */}
        <div className="p-3 border-t border-[#21262d]">
          <Button
            onClick={() => router.push(paths.dashboard.root.getHref())}
            className="flex items-center space-x-1.5 text-gray-400 hover:text-white text-xs"
          >
            <Cog6ToothIcon className="h-3.5 w-3.5" />
            <span>Settings</span>
          </Button>
        </div>
      </div>
    )
}