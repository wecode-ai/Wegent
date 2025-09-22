// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import '@/features/common/scrollbar.css'
import { RiRobot2Line } from 'react-icons/ri'
import { FiArrowRight } from 'react-icons/fi'
import { AiOutlineTeam } from 'react-icons/ai'
import LoadingState from '@/features/common/LoadingState'
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Bot, Team } from '@/types/api'
import { fetchTeamsList, deleteTeam } from '../services/teams'
import { fetchBotsList } from '../services/bots'
import TeamEdit from './TeamEdit'
import { App } from 'antd'
import { Button } from '@headlessui/react'

export default function TeamList() {
  const { message } = App.useApp()
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // 已用 antd message.error 统一错误提示，无需本地 error 状态
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [editingTeamId, setEditingTeamId] = useState<number | null>(null)

  useEffect(() => {
    async function loadData() {
      setIsLoading(true)
      try {
        const [teamsData, botsData] = await Promise.all([fetchTeamsList(), fetchBotsList()])
        setTeams(teamsData)
        setBots(botsData)
      } catch (e) {
        message.error('Failed to load teams or bots')
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [])

  const handleCreateTeam = () => {
    setEditingTeamId(0) // 用 0 标记新建
  }

  const handleEditTeam = (team: Team) => {
    setEditingTeamId(team.id)
  }

  const handleDelete = async (teamId: number) => {
    setDeletingId(teamId)
    try {
      await deleteTeam(teamId)
      setTeams(prev => prev.filter(team => team.id !== teamId))
    } catch (e) {
      message.error('Failed to delete team')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-white mb-1">Team List</h2>
          <p className="text-sm text-gray-400 mb-1">View all teams and their bots</p>
        </div>
        <div className={`bg-[#161b22] border border-[#30363d] rounded-md p-2 space-y-1 overflow-y-auto custom-scrollbar ${editingTeamId !== null ? 'md:min-h-[65vh] flex items-center justify-center' : 'max-h-[70vh]'}`}>
          {isLoading ? (
            <LoadingState fullScreen={false} message="Loading teams..." />
          ) : (
            <>
              {/* 编辑/新建模式 */}
              {editingTeamId !== null ? (
                <TeamEdit
                  teams={teams}
                  setTeams={setTeams}
                  editingTeamId={editingTeamId}
                  setEditingTeamId={setEditingTeamId}
                  bots={bots}
                  message={message}
                />
              ) : (
                <>
                  {teams.length > 0 ? (
                    teams.map((team) => (
                      <div key={team.id}>
                        <div className="flex items-center justify-between py-0.5">
                          <div className="flex items-center space-x-2 flex-1 overflow-hidden">
                            <AiOutlineTeam className="w-4 h-4 flex-shrink-0" />
                            <div className="flex flex-col justify-center flex-1 overflow-hidden">
                              <div className="flex items-center space-x-1">
                                <h3 className="text-base font-medium text-white mb-0">{team.name}</h3>
                                <div className="flex items-center h-4 space-x-0.5">
                                  <div className={`w-2 h-2 rounded-full ${team.is_active ? 'bg-green-400' : 'bg-gray-400'}`}></div>
                                  <span className="text-xs text-gray-400 flex items-center justify-center">{team.is_active ? 'Active' : 'Inactive'}</span>
                                </div>
                              </div>
                              <div className="flex items-center space-x-1 mt-0">
                                {team.workflow?.mode && (
                                  <>
                                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-700 text-gray-300 capitalize">
                                      {team.workflow.mode}
                                    </span>
                                    <span className="mx-2"></span>
                                  </>
                                )}
                                {team.bots.length > 0 ? (
                                  <div className="flex items-center max-w-[80%] overflow-hidden whitespace-nowrap text-ellipsis ml-4">
                                    {team.bots.map((bot, idx) => (
                                      <span key={`${bot.bot_id}-${idx}`} className="flex items-center">
                                        <RiRobot2Line className="w-4 h-4 mr-0.5 text-gray-400" />
                                        <span className="text-xs text-gray-400 mr-0.5">
                                          {bots.find(b => b.id === bot.bot_id)?.name || bot.bot_id}
                                        </span>
                                        {team.workflow?.mode === 'pipeline'
                                          ? (idx < team.bots.length - 1 && (
                                              <FiArrowRight className="w-4 h-4 text-gray-400 mx-2" />
                                            ))
                                          : (idx < team.bots.length - 1 && (
                                              <span className="text-gray-400 mx-1"> </span>
                                            ))
                                        }
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-gray-500">No bots</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              type="button"
                              className="p-1 text-gray-400 hover:text-white hover:bg-[#21262d] rounded transition-colors duration-200"
                              title="Edit Team"
                              onClick={() => handleEditTeam(team)}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              className="p-1 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors duration-200"
                              title="Delete Team"
                              disabled={deletingId === team.id}
                              onClick={() => handleDelete(team.id)}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                        {teams.length > 1 && team.id !== teams[teams.length - 1].id && (
                          <div className="border-t border-[#30363d] mt-1 pt-1"></div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-center text-gray-500 py-4">
                      <p className="text-sm">No teams available</p>
                    </div>
                  )}
                  <div className="border-t border-[#30363d]"></div>
                  <div className="flex justify-center">
                    <Button
                      onClick={handleCreateTeam}
                      className="flex items-center space-x-1 mt-2 mb-2 px-2 py-0.5 text-xs font-medium text-gray-900 rounded transition-colors duration-200"
                      style={{ backgroundColor: 'rgb(112,167,215)' }}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      <span>New Team</span>
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {/* 错误提示已用 antd message 统一，不再本地渲染 */}
    </>
  )
}