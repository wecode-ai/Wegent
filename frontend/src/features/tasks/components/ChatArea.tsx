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

interface ChatAreaProps {
  teams: Team[]
  isTeamsLoading: boolean
  selectedTeamForNewTask?: Team | null
}

export default function ChatArea({ teams, isTeamsLoading, selectedTeamForNewTask }: ChatAreaProps) {
  const { message } = App.useApp()
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  const [taskInputMessage, setTaskInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // Unified error prompt using antd message.error, no local error state needed
  const [error, setError] = useState('')

  const scrollContainerRef = useRef<HTMLDivElement>(null)
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
      repo: selectedRepo,
      branch: selectedBranch,
      task_id: selectedTaskDetail?.id,
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
      setTimeout(scrollToBottom, 0)
    }
    setIsLoading(false)
  }

  const scrollToBottom = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
    }
  }

  useEffect(() => {
    if (hasMessages) {
      // Use timeout to ensure DOM is updated before scrolling
      setTimeout(scrollToBottom, 0)
    }
  }, [selectedTaskDetail])

  // Style reference: TaskParamWrapper.tsx
  return (
    <div className={
      hasMessages
        ? "flex-1 flex flex-col min-h-0 w-full"
        : "flex w-full items-center justify-center h-full px-4"
    } style={{ height: '100%', boxSizing: 'border-box' }}>
      {hasMessages ? (
        <>
          {/* Messages Area */}
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto custom-scrollbar">
            <div className="w-full max-w-3xl mx-auto px-4 sm:px-6">
              <MessagesArea />
            </div>
          </div>

          {/* Input Area */}
          <div className="w-full max-w-3xl mx-auto px-4 sm:px-6">
            {/* Error Message */}
            {/* Error prompt unified with antd message, no local rendering */}
            {/* Chat Input */}
            <div className="relative w-full flex flex-col rounded-xl border border-border bg-surface">
              <ChatInput
                message={taskInputMessage}
                setMessage={setTaskInputMessage}
                handleSendMessage={handleSendMessage}
                isLoading={isLoading}
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
                  <QuotaUsage className="mr-2" />
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
            </div>
          </div>
        </>
      ) : (
        <div className="w-full max-w-3xl flex flex-col justify-center h-full">
          {/* Error Message */}
          {/* Error prompt unified with antd message, no local rendering */}
          {/* Chat Input */}
          <div className="relative w-full flex flex-col rounded-xl border border-border bg-surface">
            <ChatInput
              message={taskInputMessage}
              setMessage={setTaskInputMessage}
              handleSendMessage={handleSendMessage}
              isLoading={isLoading}
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
                <QuotaUsage className="mr-2" />
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
          </div>
        </div>
      )}
    </div>
  )
}
