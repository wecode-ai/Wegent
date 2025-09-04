// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import MessagesArea from './MessagesArea'
import ChatInput from './ChatInput'
import TeamSelector from './TeamSelector'
import RepositorySelector from './RepositorySelector'
import BranchSelector from './BranchSelector'
import type { Team, GitRepoInfo, GitBranch } from '@/types/api'
import { sendMessage } from '../service/messageService'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTaskContext } from '../contexts/taskContext'

interface ChatAreaProps {
  teams: Team[]
  isTeamsLoading: boolean
}

export default function ChatArea({ teams, isTeamsLoading }: ChatAreaProps) {
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  const [taskInputMessage, setTaskInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const router = useRouter()
  const searchParams = useSearchParams()

  // New: Get selectedTask to determine if there are messages
  const { selectedTask } = useTaskContext()
  const hasMessages = Boolean(selectedTask && selectedTask.id)

  const handleSendMessage = async () => {
    setIsLoading(true)
    setError('')
    const { error, newTask } = await sendMessage({
      message: taskInputMessage,
      team: selectedTeam,
      repo: selectedRepo,
      branch: selectedBranch,
    })
    if (error) {
      setError(error)
    } else {
      setTaskInputMessage('')
      // Redirect to task URL after successfully creating a task
      if (newTask && newTask.id) {
        const params = new URLSearchParams(Array.from(searchParams.entries()))
        params.set('taskId', String(newTask.id))
        router.push(`?${params.toString()}`)
      }
    }
    setIsLoading(false)
  }

  // Style reference: TaskParamWrapper.tsx
  return (
    <div className={
      hasMessages
        ? "flex-1 flex flex-col min-h-0 w-full items-center px-4"
        : "flex w-full items-center justify-center h-full px-4"
    }>
      <div className={
        hasMessages
          ? "w-full max-w-2xl flex-1 flex flex-col min-h-0"
          : "w-full max-w-2xl flex flex-col justify-center h-full"
      }>
        {/* Error Message */}
        {error && (
          <div className="mb-4 bg-red-900/20 border border-red-800/50 rounded-md p-3">
            <div className="text-sm text-red-300">{error}</div>
          </div>
        )}

        {/* Messages Area - Only shown when there are messages */}
        {hasMessages && (
          <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
            <MessagesArea />
          </div>
        )}

        {/* Chat Input */}
        <div className="relative w-full">
          <ChatInput
            message={taskInputMessage}
            setMessage={setTaskInputMessage}
            handleSendMessage={handleSendMessage}
            isLoading={isLoading}
            disabled={hasMessages}
          />
          {/* Team Selector - absolute left bottom inside ChatInput */}
          {teams.length > 0 && (
            <div className="absolute left-3 bottom-3 z-10">
              <TeamSelector
                selectedTeam={selectedTeam}
                setSelectedTeam={setSelectedTeam}
                teams={teams}
                disabled={hasMessages}
                isLoading={isTeamsLoading}
              />
            </div>
          )}
        </div>

        {/* Bottom Controls */}
        <div className="flex flex-row gap-1 mb-4 items-center">
          <RepositorySelector
            selectedRepo={selectedRepo}
            handleRepoChange={setSelectedRepo}
            disabled={hasMessages}
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
    </div>
  )
}