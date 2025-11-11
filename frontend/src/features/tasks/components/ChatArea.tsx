// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef } from 'react'
import { ArrowTurnDownLeftIcon } from '@heroicons/react/24/outline'
import MessagesArea from './MessagesArea'
import ChatInput from './ChatInput'
import TeamSelector from './TeamSelector'
import RepositorySelector from './RepositorySelector'
import BranchSelector from './BranchSelector'
import type { Team, GitRepoInfo, GitBranch } from '@/types/api'
import { sendMessage } from '../service/messageService'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTaskContext } from '../contexts/taskContext'
import { App, Button } from 'antd'
import QuotaUsage from './QuotaUsage'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const SHOULD_HIDE_QUOTA_NAME_LIMIT = 18

interface ChatAreaProps {
  teams: Team[]
  isTeamsLoading: boolean
  selectedTeamForNewTask?: Team | null
  showRepositorySelector?: boolean
  taskType?: 'chat' | 'code'
}

export default function ChatArea({ teams, isTeamsLoading, selectedTeamForNewTask, showRepositorySelector = true, taskType = 'chat' }: ChatAreaProps) {
  const { message } = App.useApp()
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)
  const isMobile = useMediaQuery('(max-width: 640px)')

  const [taskInputMessage, setTaskInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // Unified error prompt using antd message.error, no local error state needed
  const [error, setError] = useState('')

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isUserNearBottomRef = useRef(true)
  const AUTO_SCROLL_THRESHOLD = 32
  const router = useRouter()
  const searchParams = useSearchParams()

  // New: Get selectedTask to determine if there are messages
  const { selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail, setSelectedTask } = useTaskContext()
  const hasMessages = Boolean(selectedTaskDetail && selectedTaskDetail.id)

  useEffect(() => {
    if (!teams.length) return

    const teamIdParam = searchParams.get('teamId')
    if (!teamIdParam) return

    const matchedTeam = teams.find(team => String(team.id) === teamIdParam) || null

    if (matchedTeam && !selectedTeam) {
      setSelectedTeam(matchedTeam)
    }
  }, [teams, searchParams, setSelectedTeam])

  // Handle external team selection for new tasks (from team sharing)
  useEffect(() => {
    if (selectedTeamForNewTask && !hasMessages) {
      setSelectedTeam(selectedTeamForNewTask)
    }
  }, [selectedTeamForNewTask, hasMessages])

  const shouldHideQuotaUsage = React.useMemo(() => {
    if (!isMobile || !selectedTeam?.name) return false
    
    if (selectedTeam.share_status === 2 && selectedTeam.user?.user_name) {
      return selectedTeam.name.trim().length > 12
    }
    
    return selectedTeam.name.trim().length > SHOULD_HIDE_QUOTA_NAME_LIMIT
  }, [selectedTeam, isMobile])

  const handleTeamChange = (team: Team | null) => {
    setSelectedTeam(team)

    const params = new URLSearchParams(Array.from(searchParams.entries()))
    if (params.has('teamId')) {
      params.delete('teamId')
      router.push(`?${params.toString()}`)
    }
  }

  const handleSendMessage = async () => {
    setIsLoading(true)
    setError('')
    const { error, newTask } = await sendMessage({
      message: taskInputMessage,
      team: selectedTeam,
      repo: showRepositorySelector ? selectedRepo : null,
      branch: showRepositorySelector ? selectedBranch : null,
      task_id: selectedTaskDetail?.id,
      taskType: taskType,
    })
    if (error) {
      message.error(error)
    } else {
      setTaskInputMessage('')
      // Redirect to task URL after successfully creating a task
      if (newTask && newTask.task_id) {
        const params = new URLSearchParams(Array.from(searchParams.entries()))
        params.set('taskId', String(newTask.task_id))
        router.push(`?${params.toString()}`)
        // Actively refresh task list and task details
        refreshTasks();
        setSelectedTask({ id: newTask.task_id } as any); // Only pass id, detail component will auto-fetch
      } else if (selectedTaskDetail?.id) {
        // If appending message to existing task, also refresh task details
        refreshTasks();
        // Actively refresh task details to ensure latest status and messages
        refreshSelectedTaskDetail(false); // false means not auto-refresh, allow fetching completed task details
      }
      // Manually trigger scroll to bottom after sending message
      setTimeout(() => scrollToBottom(true), 0)
    }
    setIsLoading(false)
  }

  const scrollToBottom = (force = false) => {
    const container = scrollContainerRef.current
    if (!container) return

    if (force || isUserNearBottomRef.current) {
      container.scrollTop = container.scrollHeight
      // Force means user initiated action, treat as pinned to bottom
      if (force) {
        isUserNearBottomRef.current = true
      }
    }
  }

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      isUserNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD
    }

    container.addEventListener('scroll', handleScroll)
    // Initialize state based on current position
    handleScroll()

    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [hasMessages])

  useEffect(() => {
    if (hasMessages) {
      // Use timeout to ensure DOM is updated before scrolling
      // Force scroll to bottom when opening a historical task
      setTimeout(() => scrollToBottom(true), 100)
    }
  }, [selectedTaskDetail?.id])

  // Style reference: TaskParamWrapper.tsx
  return (
    <div
      className="flex-1 flex flex-col min-h-0 w-full"
      style={{ height: '100%', boxSizing: 'border-box' }}
    >
      {/* Messages Area: always mounted to keep scroll container stable */}
      <div
        ref={scrollContainerRef}
        className={
          (hasMessages
            ? "flex-1 overflow-y-auto custom-scrollbar"
            : "overflow-y-hidden") +
          " transition-opacity duration-200 " +
          (hasMessages ? "opacity-100" : "opacity-0 pointer-events-none h-0")
        }
        aria-hidden={!hasMessages}
      >
        <div className="w-full max-w-3xl mx-auto px-4 sm:px-6">
          <MessagesArea />
        </div>
      </div>

      {/* Main Content Area */}
      <div className={hasMessages ? "w-full" : "flex-1 flex flex-col items-center justify-center w-full"}>
        {/* Input Area */}
        <div className={hasMessages ? "w-full max-w-3xl mx-auto px-4 sm:px-6" : "w-full max-w-3xl px-4 sm:px-6"}>
          {/* Chat Input Card */}
          <div className="relative w-full flex flex-col rounded-xl border border-border bg-surface">
            <ChatInput
              message={taskInputMessage}
              setMessage={setTaskInputMessage}
              handleSendMessage={handleSendMessage}
              isLoading={isLoading}
              taskType={taskType}
            />
            {/* Team Selector and Send Button */}
            <div className="flex items-end justify-between px-3 py-0">
              <div>
                {teams.length > 0 && (
                  <TeamSelector
                    selectedTeam={selectedTeam}
                    setSelectedTeam={handleTeamChange}
                    teams={teams}
                    disabled={hasMessages}
                    isLoading={isTeamsLoading}
                  />
                )}
              </div>
              <div className="ml-auto flex items-center">
                {!shouldHideQuotaUsage && <QuotaUsage className="mr-2" />}
                <Button
                  type="text"
                  onClick={handleSendMessage}
                  disabled={isLoading}
                  icon={<ArrowTurnDownLeftIcon className="w-4 h-4" />}
                  style={{
                    color: 'rgb(var(--color-text-muted))',
                    padding: '0',
                    height: 'auto'
                  }}
                />
              </div>
            </div>
          </div>

          {/* Bottom Controls */}
          <div className="flex flex-row gap-1 mb-4 ml-3 mt-1 items-center flex-wrap">
            {showRepositorySelector && (
              <>
                <RepositorySelector
                  selectedRepo={selectedRepo}
                  handleRepoChange={setSelectedRepo}
                  disabled={hasMessages}
                  selectedTaskDetail={selectedTaskDetail}
                />

                {selectedRepo && (
                  <BranchSelector
                    selectedRepo={selectedRepo}
                    selectedBranch={selectedBranch}
                    handleBranchChange={setSelectedBranch}
                    disabled={hasMessages}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
