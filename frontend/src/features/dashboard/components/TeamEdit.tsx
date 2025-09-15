// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Select, Radio } from 'antd'
import { RiRobot2Line } from 'react-icons/ri'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import Modal from '@/features/common/Modal'
import { Listbox } from '@headlessui/react'
import { Bot, Team } from '@/types/api'
import { createTeam, updateTeam } from '../services/teams'

interface TeamEditProps {
  isOpen: boolean
  onClose: () => void
  editingTeam: Team | null
  bots: Bot[]
  onTeamCreated: (team: Team) => void
  onTeamUpdated: (team: Team) => void
}

export default function TeamEdit({
  isOpen,
  onClose,
  editingTeam,
  bots,
  onTeamCreated,
  onTeamUpdated
}: TeamEditProps) {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'pipeline' | 'route' | 'coordinate' | 'collaborate'>('pipeline')
  const [steps, setSteps] = useState([{ bot_id: 0, prompt: '' }])
  const [multiBotIds, setMultiBotIds] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isOpen) {
      if (editingTeam) {
        setName(editingTeam.name)
        setMode(editingTeam.workflow?.mode || 'pipeline')
        setSteps(editingTeam.bots.map(b => ({ bot_id: b.bot_id, prompt: b.bot_prompt })))
        if (['route', 'coordinate', 'collaborate'].includes(editingTeam.workflow?.mode)) {
          setMultiBotIds(editingTeam.bots.map(b => b.bot_id))
        } else {
          setMultiBotIds([])
        }
      } else {
        setName('')
        setMode('pipeline')
        setSteps([{ bot_id: bots[0]?.id || 0, prompt: '' }])
        setMultiBotIds([])
      }
      setError('')
    }
  }, [isOpen, editingTeam, bots])

  const handleStepChange = (idx: number, key: 'bot_id' | 'prompt', value: any) => {
    setSteps(prev =>
      prev.map((step, i) => (i === idx ? { ...step, [key]: value } : step))
    )
  }

  const handleModeChange = (newMode: 'pipeline' | 'route' | 'coordinate' | 'collaborate') => {
    setMode(newMode)
    if (newMode === 'pipeline') {
      setSteps([{ bot_id: bots[0]?.id || 0, prompt: '' }])
      setMultiBotIds([])
    } else {
      setSteps([])
      setMultiBotIds([])
    }
  }

  const handleAddStep = () => {
    setSteps(prev => [...prev, { bot_id: bots[0]?.id || 0, prompt: '' }])
  }

  const handleMultiBotChange = (selectedIds: number[]) => {
    if (selectedIds.length === 0) {
      setMultiBotIds([])
      setError('')
      return
    }
    // 获取所选bot的agent_name
    const selectedBots = bots.filter(bot => selectedIds.includes(bot.id))
    const agentNames = Array.from(new Set(selectedBots.map(bot => bot.agent_name)))
    if (agentNames.length > 1) {
      setError('只能选择 agent_name 相同的 Bot，请重新选择。')
      return
    }
    setMultiBotIds(selectedIds)
    setError('')
  }

  const handleRemoveStep = (idx: number) => {
    setSteps(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev)
  }

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Team name is required')
      return
    }
    let botsData
    if (mode === 'pipeline') {
      if (steps.some(s => !s.bot_id)) {
        setError('Each step must select a bot')
        return
      }
      botsData = steps.map(s => ({
        bot_id: s.bot_id,
        bot_prompt: s.prompt.trim()
      }))
    } else {
      if (multiBotIds.length === 0) {
        setError('At least one bot must be selected')
        return
      }
      botsData = multiBotIds.map(id => ({
        bot_id: id,
        bot_prompt: ''
      }))
    }
    setSaving(true)
    setError('')
    try {
      const workflow = { mode }
      if (editingTeam) {
        const updated = await updateTeam(editingTeam.id, {
          name: name.trim(),
          workflow,
          bots: botsData
        })
        onTeamUpdated(updated)
      } else {
        const created = await createTeam({
          name: name.trim(),
          workflow,
          bots: botsData
        })
        onTeamCreated(created)
      }
      onClose()
    } catch (e: any) {
      setError(e?.message || (editingTeam ? 'Failed to edit team' : 'Failed to create team'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose()
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
            Mode <span className="text-red-400">*</span>
          </label>
          <Radio.Group
            value={mode}
            onChange={(e) => handleModeChange(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={['pipeline', 'route', 'coordinate', 'collaborate'].map(opt => ({
              label: opt.charAt(0).toUpperCase() + opt.slice(1),
              value: opt,
              style: { minWidth: 90, textAlign: 'center' }
            }))}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-white mb-2">
            {mode === 'pipeline' ? 'Steps' : 'Bots'}
          </label>
          {/* 错误提示放在Bots label下方、Select上方 */}
          {mode !== 'pipeline' && error && (
            <p className="text-xs text-red-400 leading-none mb-1" style={{padding: 0, margin: 0}}>
              {error}
            </p>
          )}
          {mode === 'pipeline' ? (
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
          ) : (
            <Select
              mode="multiple"
              allowClear
              style={{ width: '100%' }}
              placeholder="Choose bots"
              value={multiBotIds}
              onChange={handleMultiBotChange}
              options={bots.map(bot => ({
                label: (
                  <div className="flex items-center space-x-2">
                    <RiRobot2Line className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
                    <span className="font-medium text-xs truncate">
                      {bot.name} <span className="text-gray-400">({bot.agent_name})</span>
                    </span>
                  </div>
                ),
                value: bot.id,
              }))}
            />
          )}
        </div>
      </div>
      <div className="flex space-x-3 mt-6">
        <button
          onClick={() => {
            onClose()
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
  )
}