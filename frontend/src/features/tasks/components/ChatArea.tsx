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
import { App } from 'antd'

interface ChatAreaProps {
  teams: Team[]
  isTeamsLoading: boolean
}

export default function ChatArea({ teams, isTeamsLoading }: ChatAreaProps) {
  const { message } = App.useApp()
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  const [taskInputMessage, setTaskInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // 已用 antd message.error 统一错误提示，无需本地 error 状态
  const [error, setError] = useState('')

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const searchParams = useSearchParams()

  // New: Get selectedTask to determine if there are messages
  const { selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail, setSelectedTask } = useTaskContext()
  const hasMessages = Boolean(selectedTaskDetail && selectedTaskDetail.id)

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
        // 主动刷新任务列表和任务详情
        refreshTasks();
        setSelectedTask({ id: newTask.task_id } as any); // 只传 id，详情组件会自动拉取
      } else if (selectedTaskDetail?.id) {
        // 如果是追加消息到现有任务，也刷新任务详情
        refreshTasks();
        // 主动刷新任务详情，确保能够获取最新的任务状态和消息
        refreshSelectedTaskDetail(false); // false 表示这不是自动刷新，允许获取已完成任务的详情
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
    }>
      {hasMessages ? (
        <>
          {/* Messages Area */}
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto custom-scrollbar">
            <div className="w-full max-w-2xl mx-auto px-4">
              <MessagesArea />
            </div>
          </div>

          {/* Input Area */}
          <div className="w-full max-w-2xl mx-auto px-4">
            {/* Error Message */}
            {/* 错误提示已用 antd message 统一，不再本地渲染 */}
            {/* Chat Input */}
            <div className="relative w-full flex flex-col rounded-xl border border-[#30363d] bg-[#161b22]">
              <ChatInput
                message={taskInputMessage}
                setMessage={setTaskInputMessage}
                handleSendMessage={handleSendMessage}
                isLoading={isLoading}
              />
              {/* Team Selector and Send Button */}
              <div className="flex items-end justify-between px-3 py-2">
                <div>
                  {teams.length > 0 && (
                    <TeamSelector
                      selectedTeam={selectedTeam}
                      setSelectedTeam={setSelectedTeam}
                      teams={teams}
                      disabled={hasMessages}
                      isLoading={isTeamsLoading}
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleSendMessage}
                  disabled={isLoading}
                  className="relative top-1 text-gray-500 hover:text-white transition-colors duration-200 disabled:opacity-50"
                >
                  <ArrowTurnDownLeftIcon className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Bottom Controls */}
            <div className="flex flex-row gap-1 mb-4 ml-3 mt-1 items-center">
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
        <div className="w-full max-w-2xl flex flex-col justify-center h-full">
          {/* Error Message */}
          {/* 错误提示已用 antd message 统一，不再本地渲染 */}
          {/* Chat Input */}
          <div className="relative w-full flex flex-col rounded-xl border border-[#30363d] bg-[#161b22]">
            <ChatInput
              message={taskInputMessage}
              setMessage={setTaskInputMessage}
              handleSendMessage={handleSendMessage}
              isLoading={isLoading}
            />
            {/* Team Selector and Send Button */}
            <div className="flex items-end justify-between px-3 py-2">
              <div>
                {teams.length > 0 && (
                  <TeamSelector
                    selectedTeam={selectedTeam}
                    setSelectedTeam={setSelectedTeam}
                    teams={teams}
                    disabled={hasMessages}
                    isLoading={isTeamsLoading}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={handleSendMessage}
                disabled={isLoading}
                className="relative top-1 text-gray-500 hover:text-white transition-colors duration-200 disabled:opacity-50"
              >
                <ArrowTurnDownLeftIcon className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Bottom Controls */}
          <div className="flex flex-row gap-1 mb-4 ml-3 mt-1 items-center">
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