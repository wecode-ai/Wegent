// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { RiRobot2Line } from 'react-icons/ri'
import { FiArrowRight } from 'react-icons/fi'
import { AiOutlineTeam } from 'react-icons/ai'
import LoadingState from '@/features/common/LoadingState'
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Bot, Team } from '@/types/api'
import { fetchTeamsList, deleteTeam } from '../services/teams'
import { fetchBotsList } from '../services/bots'
import TeamEdit from './TeamEdit'

export default function TeamList() {
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [editingTeam, setEditingTeam] = useState<Team | null>(null)

  useEffect(() => {
    async function loadData() {
      setIsLoading(true)
      try {
        const [teamsData, botsData] = await Promise.all([fetchTeamsList(), fetchBotsList()])
        setTeams(teamsData)
        setBots(botsData)
      } catch (e) {
        setError('Failed to load teams or bots')
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [])

  const handleOpenModal = () => {
    setEditingTeam(null)
    setShowModal(true)
  }

  const handleOpenEditModal = (team: Team) => {
    setEditingTeam(team)
    setShowModal(true)
  }

  const handleTeamCreated = (createdTeam: Team) => {
    setTeams(prev => [createdTeam, ...prev])
  }

  const handleTeamUpdated = (updatedTeam: Team) => {
    setTeams(prev => prev.map(team => team.id === updatedTeam.id ? updatedTeam : team))
  }

  const handleDelete = async (teamId: number) => {
    setDeletingId(teamId)
    try {
      await deleteTeam(teamId)
      setTeams(prev => prev.filter(team => team.id !== teamId))
    } catch (e) {
      setError('Failed to delete team')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-white mb-2">Team List</h2>
          <p className="text-sm text-gray-400">View all teams and their bots</p>
        </div>
        <div className="bg-[#161b22] border border-[#30363d] rounded-md p-4 space-y-3">
          {isLoading ? (
            <LoadingState fullScreen={false} message="Loading teams..." />
          ) : (
            <>
              {teams.length > 0 ? (
                teams.map((team) => (
                  <div key={team.id}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <AiOutlineTeam className="w-5 h-5 flex-shrink-0" />
                        <div>
                          <div className="flex items-center space-x-2">
                            <h3 className="text-base font-medium text-white">{team.name}</h3>
                            <div className="flex items-center space-x-1">
                              <div className={`w-2 h-2 rounded-full ${team.is_active ? 'bg-green-400' : 'bg-gray-400'}`}></div>
                              <span className="text-xs text-gray-400">{team.is_active ? 'Active' : 'Inactive'}</span>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2 mt-1">
                            {team.workflow?.mode && (
                              <span className="px-2 py-0.5 text-xs rounded-full bg-gray-700 text-gray-300 capitalize">
                                {team.workflow.mode}
                              </span>
                            )}
                            {team.bots.length > 0 ? (
                              <div className="flex items-center overflow-x-auto max-w-[320px] whitespace-nowrap">
                                {team.bots.map((bot, idx) => (
                                  <span key={`${bot.bot_id}-${idx}`} className="flex items-center">
                                    <RiRobot2Line className="w-4 h-4 mr-0.5 text-gray-400" />
                                    <span className="text-xs text-gray-400 mr-0.5">
                                      {bots.find(b => b.id === bot.bot_id)?.name || bot.bot_id}
                                    </span>
                                    {idx < team.bots.length - 1 && (
                                      <FiArrowRight className="w-4 h-4 text-gray-400 mx-2" />
                                    )}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-500">No bots</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 mt-1">{team.description}</p>
                        </div>
                      </div>
                      <div className="flex items-center">
                        <button
                          type="button"
                          className="p-1.5 text-gray-400 hover:text-white hover:bg-[#21262d] rounded transition-colors duration-200"
                          title="Edit Team"
                          onClick={() => handleOpenEditModal(team)}
                        >
                          <PencilIcon className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors duration-200"
                          title="Delete Team"
                          disabled={deletingId === team.id}
                          onClick={() => handleDelete(team.id)}
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {teams.length > 1 && team.id !== teams[teams.length - 1].id && (
                      <div className="border-t border-[#30363d] mt-3 pt-3"></div>
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
                <button
                  onClick={handleOpenModal}
                  className="flex items-center space-x-1 px-3 py-1 text-xs font-medium text-gray-900 rounded transition-colors duration-200"
                  style={{ backgroundColor: 'rgb(112,167,215)' }}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  <span>New Team</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <TeamEdit
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        editingTeam={editingTeam}
        bots={bots}
        onTeamCreated={handleTeamCreated}
        onTeamUpdated={handleTeamUpdated}
      />
    </>
  )
}