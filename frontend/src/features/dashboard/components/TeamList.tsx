// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { RiRobot2Line } from 'react-icons/ri'
import { FiArrowRight } from 'react-icons/fi'
import { AiOutlineTeam } from 'react-icons/ai'
import LoadingState from '@/features/common/LoadingState'
import Modal from '@/features/common/Modal'
import { Listbox } from '@headlessui/react'
import { ChevronDownIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Bot,Team } from '@/types/api'
import { fetchTeamsList, createTeam, deleteTeam, updateTeam } from '../services/teams'
import { fetchBotsList } from '../services/bots'

export default function TeamList() {
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [steps, setSteps] = useState([{ bot_id: 0, prompt: '' }])
  const [saving, setSaving] = useState(false)
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
    setName('')
    setSteps([{ bot_id: bots[0]?.id || 0, prompt: '' }])
    setError('')
    setEditingTeam(null)
    setShowModal(true)
  }

  const handleOpenEditModal = (team: Team) => {
    setName(team.name)
    setSteps(team.bots.map(b => ({ bot_id: b.bot_id, prompt: b.bot_prompt })))
    setError('')
    setEditingTeam(team)
    setShowModal(true)
  }

  const handleStepChange = (idx: number, key: 'bot_id' | 'prompt', value: any) => {
    setSteps(prev =>
      prev.map((step, i) => (i === idx ? { ...step, [key]: value } : step))
    )
  }

  const handleAddStep = () => {
    setSteps(prev => [...prev, { bot_id: bots[0]?.id || 0, prompt: '' }])
  }

  const handleRemoveStep = (idx: number) => {
    setSteps(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev)
  }

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Team name is required')
      return
    }
    if (steps.some(s => !s.bot_id)) {
      setError('Each step must select a bot')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (editingTeam) {
        const updated = await updateTeam(editingTeam.id, {
          name: name.trim(),
          bots: steps.map(s => ({
            bot_id: s.bot_id,
            bot_prompt: s.prompt.trim()
          }))
        })
        setTeams(prev => prev.map(team => team.id === editingTeam.id ? updated : team))
      } else {
        const created = await createTeam({
          name: name.trim(),
          bots: steps.map(s => ({
            bot_id: s.bot_id,
            bot_prompt: s.prompt.trim()
          }))
        })
        setTeams(prev => [created, ...prev])
      }
      setShowModal(false)
    } catch (e: any) {
      setError(e?.message || (editingTeam ? 'Failed to edit team' : 'Failed to create team'))
    } finally {
      setSaving(false)
    }
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
                          {team.bots.length > 0 ? (
                            <div className="flex items-center mt-1 overflow-x-auto max-w-[320px] whitespace-nowrap">
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
                            <span className="text-xs text-gray-500 ml-2">No bots</span>
                          )}
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
      {/* New Team Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false)
          setError('')
        }}
        title={editingTeam ? "Edit Team" : "Create New Team"}
        maxWidth="3xl"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-white mb-2">
              Team Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Team Name"
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-white mb-2">
              Steps
            </label>
            <div className="space-y-4">
              {steps.length === 0 ? (
                <div className="flex items-center">
                  <div className="flex-1"></div>
                  <button
                    type="button"
                    onClick={handleAddStep}
                    className="px-2 py-1 text-xs text-gray-400 hover:text-green-400"
                  >+</button>
                </div>
              ) : (
                steps.map((step, idx) => (
                  <div key={idx} className="mb-2">
                    <div className="flex items-center">
                      <div className="flex flex-1">
                        <Listbox
                          value={bots.find(bot => bot.id === step.bot_id) || bots[0]}
                          onChange={bot => handleStepChange(idx, 'bot_id', bot.id)}
                        >
                          <div className="relative w-[150px]">
                            <Listbox.Button
                              className="flex items-center w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] border-r-0 rounded-l-md text-white text-xs placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
                              style={{ minWidth: 80, maxWidth: 150, textAlign: 'left' }}
                            >
                              <RiRobot2Line className="w-3 h-3 mr-1 flex-shrink-0 text-gray-400" />
                              <span className="truncate flex-1" title={bots.find(bot => bot.id === step.bot_id)?.name || ''}>
                                {bots.find(bot => bot.id === step.bot_id)?.name || ''}
                              </span>
                              <ChevronDownIcon className="w-4 h-4 ml-1 flex-shrink-0" />
                            </Listbox.Button>
                            <Listbox.Options className="absolute left-0 top-full mt-1 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-10 w-full py-1">
                              {bots.map((bot, bidx) => (
                                <Listbox.Option
                                  key={`${bot.id}-${bidx}`}
                                  value={bot}
                                  className="px-2.5 py-1.5 text-xs text-white hover:bg-[#21262d] cursor-pointer transition-colors duration-150 block"
                                  title={bot.name}
                                >
                                  <div className="flex items-center space-x-2">
                                    <RiRobot2Line className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
                                    <span className="font-medium text-xs truncate">{bot.name}</span>
                                  </div>
                                </Listbox.Option>
                              ))}
                            </Listbox.Options>
                          </div>
                        </Listbox>
                        <input
                          type="text"
                          value={step.prompt}
                          onChange={e => handleStepChange(idx, 'prompt', e.target.value)}
                          placeholder="Prompt"
                          className="flex-1 px-3 py-2 bg-[#0d1117] border border-[#30363d] border-l-0 text-white text-xs placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent focus:z-20"
                          style={{ minWidth: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderTopRightRadius: 0, borderBottomRightRadius: 0, position: 'relative', zIndex: 20 }}
                        />
                        {idx === steps.length - 1 ? (
                          <button
                            type="button"
                            onClick={handleAddStep}
                            className="px-3 py-2 text-xs text-gray-400 hover:text-white bg-[#0d1117] border border-[#30363d] border-l-0 rounded-r-md focus:outline-none focus:outline-white/25 focus:border-transparent"
                            style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
                          >+</button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRemoveStep(idx)}
                            className="px-3 py-2 text-xs text-gray-400 hover:text-white bg-[#0d1117] border border-[#30363d] border-l-0 rounded-r-md focus:outline-none focus:outline-white/25 focus:border-transparent"
                            style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
                          >-</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          {error && (
            <div className="bg-red-900/20 border border-red-800/50 rounded-md p-3">
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}
        </div>
        <div className="flex space-x-3 mt-6">
          <button
            onClick={() => {
              setShowModal(false)
              setError('')
            }}
            className="flex-1 px-2 py-1 text-xs bg-[#21262d] hover:bg-[#30363d] text-gray-300 border border-[#30363d] rounded transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 px-2 py-1 text-xs font-medium text-gray-900 rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              backgroundColor: !saving ? 'rgb(112,167,215)' : '#6b7280'
            }}
          >
            {saving ? (editingTeam ? 'Saving...' : 'Creating...') : (editingTeam ? 'Save Changes' : 'Create Team')}
          </button>
        </div>
      </Modal>
    </>
  )
}