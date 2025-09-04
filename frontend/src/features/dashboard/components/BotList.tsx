// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Button, Listbox } from '@headlessui/react'
import { CheckIcon, PencilIcon, TrashIcon, PlusIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import Modal from '@/features/common/Modal'
import LoadingState from '@/features/common/LoadingState'
import { Bot } from '@/types/api'
import { fetchBotsList, createBot, updateBot, deleteBot } from '../services/bots'

export default function BotList() {
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showBotModal, setShowBotModal] = useState(false)
  const [botName, setBotName] = useState('')
  const [agentName, setAgentName] = useState('')
  const [agentConfig, setAgentConfig] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mcpConfig, setMcpConfig] = useState('')
  const [botSaving, setBotSaving] = useState(false)
  const [botError, setBotError] = useState('')
  const [editingBotId, setEditingBotId] = useState<number | null>(null)

  const agentOptions = [
    { value: 'ClaudeCode', label: 'ClaudeCode' },
    { value: 'GeminiCli', label: 'GeminiCli', disabled: true },
    { value: 'Codex', label: 'Codex', disabled: true }
  ]

  useEffect(() => {
    async function loadBots() {
      setIsLoading(true)
      try {
        const botsData = await fetchBotsList()
        setBots(botsData)
      } catch (e) {
        setBotError('Failed to load bots')
      } finally {
        setIsLoading(false)
      }
    }
    loadBots()
  }, [])

  const handleCreateBot = () => {
    setBotName('')
    setAgentName('')
    setAgentConfig('')
    setPrompt('')
    setMcpConfig('')
    setBotError('')
    setEditingBotId(null)
    setShowBotModal(true)
  }

  const handleEditBot = (bot: Bot) => {
    setBotName(bot.name)
    setAgentName(bot.agent_name)
    setAgentConfig(JSON.stringify(bot.agent_config, null, 2))
    setPrompt(bot.system_prompt || '')
    setMcpConfig(bot.mcp_servers ? JSON.stringify(bot.mcp_servers, null, 2) : '')
    setBotError('')
    setEditingBotId(bot.id)
    setShowBotModal(true)
  }

  const handleSaveBot = async () => {
    if (!botName.trim() || !agentName.trim()) {
      setBotError('Please fill in all required fields')
      return
    }
    try {
      JSON.parse(agentConfig)
      if (mcpConfig.trim()) {
        JSON.parse(mcpConfig)
      }
    } catch (error) {
      setBotError('Agent Config must be valid JSON format, MCP Config must be valid JSON if provided')
      return
    }
    setBotSaving(true)
    setBotError('')
    try {
      const botReq: any = {
        name: botName.trim(),
        agent_name: agentName.trim(),
        agent_config: JSON.parse(agentConfig),
        system_prompt: prompt.trim() || ''
      }
      if (mcpConfig.trim()) {
        botReq.mcp_servers = JSON.parse(mcpConfig)
      }
      if (editingBotId) {
        const updated = await updateBot(editingBotId, botReq)
        setBots(prev => prev.map(b => b.id === editingBotId ? updated : b))
      } else {
        const created = await createBot(botReq)
        setBots(prev => [created, ...prev])
      }
      setShowBotModal(false)
    } catch (error: any) {
      setBotError(error.message || 'Failed to save bot')
    } finally {
      setBotSaving(false)
    }
  }

  const handleDeleteBot = async (botId: number) => {
    try {
      await deleteBot(botId)
      setBots(prev => prev.filter(b => b.id !== botId))
    } catch (e) {
      setBotError('Failed to delete bot')
    }
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-white mb-2">AI Assistant</h2>
          <p className="text-sm text-gray-400">Configure your AI-powered development assistant</p>
        </div>
        <div className="bg-[#161b22] border border-[#30363d] rounded-md p-4 space-y-3">
          {isLoading ? (
            <LoadingState fullScreen={false} message="Loading bots..." />
          ) : (
            <>
              {bots.length > 0 ? (
                bots.map((bot) => (
                  <div key={bot.id}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <RiRobot2Line className="w-4 h-4 text-white" />
                        <div>
                          <div className="flex items-center space-x-2">
                            <h3 className="text-base font-medium text-white">{bot.name}</h3>
                            <div className="flex items-center space-x-1">
                              <div className={`w-2 h-2 rounded-full ${bot.is_active ? 'bg-green-400' : 'bg-gray-400'}`}></div>
                              <span className="text-xs text-gray-400">{bot.is_active ? 'Active' : 'Inactive'}</span>
                            </div>
                          </div>
                          <p className="text-xs text-gray-400">{bot.agent_name}</p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <button
                          className="p-1.5 text-gray-400 hover:text-white hover:bg-[#21262d] rounded transition-colors duration-200"
                          title="Edit Bot"
                          onClick={() => handleEditBot(bot)}
                        >
                          <PencilIcon className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteBot(bot.id)}
                          className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors duration-200"
                          title="Delete Bot"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {bots.length > 1 && bot.id !== bots[bots.length - 1].id && (
                      <div className="border-t border-[#30363d] mt-3 pt-3"></div>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-center text-gray-500 py-4">
                  <p className="text-sm">No bots available</p>
                </div>
              )}
              <div className="border-t border-[#30363d]"></div>
              <div className="flex justify-center">
                <Button
                  onClick={handleCreateBot}
                  className="flex items-center space-x-1 px-3 py-1 text-xs font-medium text-gray-900 rounded transition-colors duration-200"
                  style={{ backgroundColor: 'rgb(112,167,215)' }}
                >
                  <PlusIcon className="w-3 h-3" />
                  <span>New Bot</span>
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      {/* Bot Creation/Edit Modal */}
      <Modal
        isOpen={showBotModal}
        onClose={() => {
          setShowBotModal(false)
          setBotError('')
        }}
        title={editingBotId ? 'Update Bot' : 'Create New Bot'}
        maxWidth="3xl"
      >
        <div className="flex flex-col md:flex-row gap-6 items-stretch min-h-[400px]">
          {/* Left form */}
          <div className="basis-[35%] min-w-0 space-y-4 h-full flex flex-col">
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                Bot Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                placeholder="Code Assistant"
                className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
              />
            </div>
            <label className="block text-sm font-medium text-white mb-2">
              Agent <span className="text-red-400">*</span>
            </label>
            <Listbox value={agentName} onChange={setAgentName}>
              <div className="relative">
                <Listbox.Button className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-left text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent">
                  {agentName
                    ? agentOptions.find(opt => opt.value === agentName)?.label
                    : <span className="text-gray-400">choose an agent</span>
                  }
                </Listbox.Button>
                <Listbox.Options className="absolute z-10 mt-1 w-full bg-[#161b22] border border-[#30363d] rounded-md shadow-lg max-h-60 py-1 text-base ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
                  {agentOptions.map((option) => (
                    <Listbox.Option
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                      className={({ active, selected, disabled }) =>
                        `select-none relative py-2 pl-3 pr-4 ${
                          disabled
                            ? 'text-gray-500 bg-[#161b22] cursor-not-allowed opacity-60'
                            : active
                              ? 'bg-[#21262d] text-white cursor-pointer'
                              : 'text-gray-300 cursor-pointer'
                        } ${selected ? 'font-semibold' : ''}`
                      }
                    >
                      {({ selected, disabled }) => (
                        <>
                          <span
                            className={`block truncate ${selected ? 'text-white' : ''} ${disabled ? 'opacity-70' : ''}`}
                          >
                            {option.label}
                            {option.disabled && (
                              <span className="ml-2 text-xs text-gray-500">(Incoming)</span>
                            )}
                          </span>
                          {selected && !disabled ? (
                            <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-blue-400">
                              <CheckIcon className="w-4 h-4" aria-hidden="true" />
                            </span>
                          ) : null}
                        </>
                      )}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </div>
            </Listbox>
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                Agent Config <span className="text-red-400">*</span>
              </label>
              <textarea
                value={agentConfig}
                onChange={(e) => setAgentConfig(e.target.value)}
                rows={3}
                placeholder={
                  agentName === 'ClaudeCode'
                    ? `{
  "env": {
    "ANTHROPIC_MODEL": "xxxxx",
    "ANTHROPIC_SMALL_FAST_MODEL": "xxxxx",
    "ANTHROPIC_API_KEY": "xxxxxx",
    "ANTHROPIC_BASE_URL": "xxxxxx"
  }
}`
                    : ''
                }
                className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">JSON format required</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                MCP Config
              </label>
              <textarea
                value={mcpConfig}
                onChange={(e) => setMcpConfig(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent font-mono text-sm flex-1"
                placeholder={`{
  "github": {
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "-e",
      "GITHUB_TOOLSETS",
      "-e",
      "GITHUB_READ_ONLY",
      "ghcr.io/github/github-mcp-server"
    ],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "xxxxxxxxxx",
      "GITHUB_TOOLSETS": "",
      "GITHUB_READ_ONLY": ""
    }
  }
}`}
              />
              <p className="text-xs text-gray-500 mt-1">JSON format required</p>
            </div>
            {botError && (
              <div className="bg-red-900/20 border border-red-800/50 rounded-md p-3">
                <p className="text-xs text-red-300">{botError}</p>
              </div>
            )}
          </div>
          {/* Right Prompt */}
          <div className="basis-[65%] min-w-0 flex flex-col h-full">
            <label className="block text-sm font-medium text-white mb-2">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="AI-powered code review and assistance"
              className="flex-1 h-full min-h-[406px] max-h-[406px] px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent resize-vertical"
            />
          </div>
        </div>
        <div className="flex space-x-3 mt-6">
          <Button
            onClick={() => {
              setShowBotModal(false)
              setBotError('')
            }}
            className="flex-1 px-2 py-1 text-xs bg-[#21262d] hover:bg-[#30363d] text-gray-300 border border-[#30363d] rounded transition-colors duration-200"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveBot}
            disabled={botSaving}
            className="flex-1 px-2 py-1 text-xs font-medium text-gray-900 rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              backgroundColor: !botSaving ? 'rgb(112,167,215)' : '#6b7280'
            }}
          >
            {botSaving
              ? (editingBotId ? 'Updating...' : 'Creating...')
              : (editingBotId ? 'Update Bot' : 'Create Bot')}
          </Button>
        </div>
      </Modal>
    </>
  )
}