import React, { useState, useEffect } from 'react'
import { Button } from 'antd'
import { Listbox } from '@headlessui/react'
import { CheckIcon } from '@heroicons/react/24/outline'

import { Bot } from '@/types/api'
import { botApis } from '@/apis/bots'
import { useTranslation } from 'react-i18next'

import type { MessageInstance } from 'antd/es/message/interface'

interface BotEditProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  editingBotId: number
  setEditingBotId: React.Dispatch<React.SetStateAction<number | null>>
  message: MessageInstance
}
const BotEdit: React.FC<BotEditProps> = ({
  bots,
  setBots,
  editingBotId,
  setEditingBotId,
  message,
}) => {
  const { t } = useTranslation()
  // 选项本地定义
  const agentOptions = [
    { value: 'ClaudeCode', label: 'ClaudeCode' },
    { value: 'Agno', label: 'Agno' },
    { value: 'GeminiCli', label: 'GeminiCli', disabled: true },
    { value: 'Codex', label: 'Codex', disabled: true }
  ]
  const [botSaving, setBotSaving] = useState(false)

  // 当前编辑对象
  const editingBot = editingBotId === 0
    ? null
    : bots.find(b => b.id === editingBotId) || null

  const [botName, setBotName] = useState(editingBot?.name || '')
  const [agentName, setAgentName] = useState(editingBot?.agent_name || '')
  const [agentConfig, setAgentConfig] = useState(
    editingBot?.agent_config ? JSON.stringify(editingBot.agent_config, null, 2) : ''
  )
  const [prompt, setPrompt] = useState(editingBot?.system_prompt || '')
  const [mcpConfig, setMcpConfig] = useState(
    editingBot?.mcp_servers ? JSON.stringify(editingBot.mcp_servers, null, 2) : ''
  )

  // 切换编辑对象时重置表单
  useEffect(() => {
    setBotName(editingBot?.name || '')
    setAgentName(editingBot?.agent_name || '')
    setAgentConfig(editingBot?.agent_config ? JSON.stringify(editingBot.agent_config, null, 2) : '')
    setPrompt(editingBot?.system_prompt || '')
    setMcpConfig(editingBot?.mcp_servers ? JSON.stringify(editingBot.mcp_servers, null, 2) : '')
  }, [editingBotId])

  // 保存逻辑
  const handleSave = async () => {
    if (!botName.trim() || !agentName.trim()) {
      message.error('请填写所有必填项')
      return
    }
    try {
      JSON.parse(agentConfig)
      if (mcpConfig.trim()) {
        JSON.parse(mcpConfig)
      }
    } catch (error) {
      message.error('Agent Config 必须为合法 JSON，MCP Config（如填写）也需合法 JSON')
      return
    }
    setBotSaving(true)
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
      if (editingBotId && editingBotId > 0) {
        // 编辑
        const updated = await botApis.updateBot(editingBotId, botReq)
        setBots(prev => prev.map(b => b.id === editingBotId ? updated : b))
      } else {
        // 新建
        const created = await botApis.createBot(botReq)
        setBots(prev => [created, ...prev])
      }
      setEditingBotId(null)
    } catch (error: any) {
      message.error(error?.message || 'save failed')
    } finally {
      setBotSaving(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 items-stretch max-w-4xl mx-auto bg-[#161b22] rounded-lg pt-0 pr-4 pb-4 pl-4 relative w-full h-full min-h-[500px] md:min-h-[65vh]">
      <div className="w-full flex items-center justify-between mb-4 mt-4">
        <button
          onClick={() => setEditingBotId(null)}
          className="flex items-center text-gray-400 hover:text-white text-base"
          title={t('common.back')}
        >
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-1">
            <path d="M15 6l-6 6 6 6"/>
          </svg>
          {t('common.back')}
        </button>

        <Button
          onClick={handleSave}
          disabled={botSaving}
          loading={botSaving}
          type="primary"
          size="small"
        >
          {botSaving ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>
      <div className="w-full flex flex-col md:flex-row gap-4 items-start mb-3 mt-3">
        {/* Bot Name */}
        <div className="w-full md:basis-1/2 flex flex-col justify-end">
          <div className="flex items-center mb-1">
            <label className="block text-lg font-semibold text-white">
                {t('bot.name')} <span className="text-red-400">*</span>
            </label>
          </div>
          <input
            type="text"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            placeholder="Code Assistant"
            className="w-full px-4 py-2 bg-[#0d1117] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent text-base"
            style={{ marginTop: '0' }}
          />
        </div>
        {/* Agent */}
        <div className="w-full md:basis-1/2 flex flex-col">
          <div className="flex items-center mb-1">
            <label className="block text-lg font-semibold text-white">
              {t('bot.agent')} <span className="text-red-400">*</span>
            </label>
          </div>
          <Listbox value={agentName} onChange={setAgentName}>
            <div className="relative">
              <Listbox.Button className="w-full px-4 py-2 bg-[#0d1117] rounded-md text-left text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent text-base">
                {agentName
                  ? agentOptions.find(opt => opt.value === agentName)?.label
                  : <span className="text-gray-400">{t('bot.agent_select')}</span>
                }
              </Listbox.Button>
              <Listbox.Options className="absolute z-10 mt-1 w-full bg-[#161b22] rounded-md shadow-lg max-h-60 py-1 text-base ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
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
        </div>
      </div>
      <div className="w-full flex flex-col md:flex-row gap-4 items-stretch flex-1 h-full py-0">
        {/* 左侧 Prompt */}
        <div className="w-full md:w-3/5 min-w-0 flex flex-col flex-1 h-full relative">
          <div className="flex items-center mb-1">
            <label className="block text-base font-medium text-white">
              {t('bot.prompt')}
            </label>
            <span className="text-xs text-gray-500 ml-2">AI prompt</span>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="AI-powered code review and assistance"
            className="w-full h-full flex-1 px-4 py-2 bg-[#0d1117] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent text-base min-h-[300px] max-h-none md:min-h-[440px] resize-none custom-scrollbar"
          />
        </div>
        {/* 右侧 Agent Config + MCP Config */}
        <div className="w-full md:w-2/5 min-w-0 space-y-3 h-full flex flex-col flex-1">
          <div className="flex-1 flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-base font-medium text-white">
                {t('bot.agent_config')} <span className="text-red-400">*</span>
              </label>
              <span className="text-xs text-gray-500 ml-2">JSON format required</span>
            </div>
            <textarea
              value={agentConfig}
              onChange={(e) => setAgentConfig(e.target.value)}
              rows={4}
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
                  : agentName === 'Agno'
                    ? `{
  "env": {
    "AGNO_MODEL": "xxxxx",
    "AGNO_API_KEY": "xxxxxx",
    "AGNO_BASE_URL": "xxxxxx"
  }
}`
                    : ''
              }
              className="w-full px-4 py-2 bg-[#0d1117] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent font-mono text-base h-full min-h-[100px] md:min-h-[200px] max-h-[450px] md:max-h-full custom-scrollbar"
            />
          </div>
          <div className="flex-1 flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-base font-medium text-white">
                {t('bot.mcp_config')}
              </label>
              <span className="text-xs text-gray-500 ml-2">JSON format required</span>
            </div>
            <textarea
              value={mcpConfig}
              onChange={(e) => setMcpConfig(e.target.value)}
              rows={4}
              className="w-full px-4 py-2 bg-[#0d1117] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent font-mono text-base h-full min-h-[100px] md:min-h-[200px] max-h-[450px] md:max-h-full custom-scrollbar"
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
          </div>
        </div>
      </div>
    </div>
  )
}

export default BotEdit