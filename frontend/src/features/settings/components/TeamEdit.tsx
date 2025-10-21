// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Radio, Transfer, Select, Button, Tooltip, Tag, theme } from 'antd'
import type { TransferDirection } from 'antd/es/transfer'
import type { MessageInstance } from 'antd/es/message/interface'
import Image from 'next/image'
import { RiRobot2Line, RiMagicLine } from 'react-icons/ri'
import { EditOutlined, DownOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons'

import { Bot, Team } from '@/types/api'
import { createTeam, updateTeam } from '../services/teams'
import TeamEditDrawer from './TeamEditDrawer'
import { useTranslation } from '@/hooks/useTranslation'
import { getPromptBadgeStyle, type PromptBadgeVariant } from '@/utils/styles'

interface TeamEditProps {
  teams: Team[]
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>
  editingTeamId: number
  setEditingTeamId: React.Dispatch<React.SetStateAction<number | null>>
  initialTeam?: Team | null
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>> // Add setBots property
  message: MessageInstance
}

export default function TeamEdit(props: TeamEditProps) {
  const {
    teams,
    setTeams,
    editingTeamId,
    setEditingTeamId,
    initialTeam = null,
    bots,
    setBots,
    message,
  } = props

  const { t } = useTranslation('common')
  const { token } = theme.useToken()
    // Current editing object (0 means create new)
  const editingTeam: Team | null = editingTeamId === 0
    ? null
    : (teams.find(t => t.id === editingTeamId) || null)

  const formTeam = editingTeam ?? (editingTeamId === 0 ? initialTeam : null) ?? null

    // Left column: Team Name, Mode, Description
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'pipeline' | 'route' | 'coordinate' | 'collaborate'>('pipeline')

    // Right column: LeaderBot (single select), Bots Transfer (multi-select)
    // Use string key for antd Transfer, stringify bot.id here
  const [selectedBotKeys, setSelectedBotKeys] = useState<React.Key[]>([])
  const [leaderBotId, setLeaderBotId] = useState<number | null>(null)

  const [saving, setSaving] = useState(false)

    // Bot editing related state
  const [editingBotDrawerVisible, setEditingBotDrawerVisible] = useState(false)
  const [editingBotId, setEditingBotId] = useState<number | null>(null)
  const [drawerMode, setDrawerMode] = useState<'edit' | 'prompt'>('edit')
  const [cloningBot, setCloningBot] = useState<Bot | null>(null)
  
    // Store unsaved team prompts
  const [unsavedPrompts, setUnsavedPrompts] = useState<Record<string, string>>({})

  const teamPromptMap = useMemo(() => {
    const map = new Map<number, boolean>()
    if (editingTeam) {
      editingTeam.bots.forEach(bot => {
        map.set(bot.bot_id, !!bot.bot_prompt?.trim())
      })
    }
    Object.entries(unsavedPrompts).forEach(([key, value]) => {
      const id = Number(key.replace('prompt-', ''))
      if (!Number.isNaN(id)) {
        map.set(id, !!value?.trim())
      }
    })
    return map
  }, [editingTeam, unsavedPrompts])

  const promptSummary = useMemo<{ label: string; variant: PromptBadgeVariant }>(() => {
    let configuredCount = 0
    teamPromptMap.forEach(value => {
      if (value) configuredCount += 1
    })
    const unsavedHasContent = Object.values(unsavedPrompts).some(value => (value ?? '').trim().length > 0)

    if (unsavedHasContent) {
      const countText = configuredCount > 0
        ? ` - ${t('team.prompts_tag_configured', { count: configuredCount })}`
        : ''
      return {
        label: `${t('team.prompts_tag_pending')}${countText}`,
        variant: 'pending',
      }
    }

    if (configuredCount > 0) {
      return {
        label: t('team.prompts_tag_configured', { count: configuredCount }),
        variant: 'configured',
      }
    }

    return {
      label: t('team.prompts_tag_none'),
      variant: 'none',
    }
  }, [teamPromptMap, unsavedPrompts, t])

  const configuredPromptBadgeStyle = useMemo(
    () => getPromptBadgeStyle(token, 'configured'),
    [token],
  )
  const promptSummaryStyle = useMemo(
    () => getPromptBadgeStyle(token, promptSummary.variant),
    [token, promptSummary.variant],
  )

  const handleBack = useCallback(() => {
    setEditingTeamId(null)
  }, [setEditingTeamId])

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (editingBotDrawerVisible) return

      handleBack()
    }

    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [handleBack, editingBotDrawerVisible])

  useEffect(() => {
    if (editingTeamId === 0 && initialTeam) {
      setUnsavedPrompts(prev => {
        if (Object.keys(prev).length > 0) {
          return prev
        }
        const next: Record<string, string> = {}
        initialTeam.bots.forEach(bot => {
          next[`prompt-${bot.bot_id}`] = bot.bot_prompt || ''
        })
        return next
      })
    }
  }, [editingTeamId, initialTeam])


    // Each Mode's "description" and "boundary", including text and images (i18n)
    const MODE_INFO = useMemo(() => {
    // i18n keys
    const titleKey = `team_model.${mode}`;
    const descKey = `team_model_desc.${mode}`;

      // Image mapping by mode
    const imageMap: Record<typeof mode, string> = {
      pipeline: '/settings/sequential.png',
      route: '/settings/router.png',
      coordinate: '/settings/network.png',
      collaborate: '/settings/parallel.png',
    };

    return {
      info: {
        title: t(titleKey),
        desc: t(descKey),
        bullets: [],
        image: imageMap[mode],
      },
    };
  }, [mode, t]);

    // Reset form when initializing/switching editing object
    // Reset form when initializing/switching editing object
  useEffect(() => {
    if (formTeam) {
      setName(formTeam.name)
      const m = (formTeam.workflow?.mode as any) || 'pipeline'
      setMode(m)
      const ids = formTeam.bots.map(b => String(b.bot_id))
      setSelectedBotKeys(ids)
      const leaderBot = formTeam.bots.find(b => b.role === 'leader')
      setLeaderBotId(leaderBot?.bot_id ?? null)
    } else {
      setName('')
      setMode('pipeline')
      setSelectedBotKeys([])
      setLeaderBotId(null)
    }
  }, [editingTeamId, formTeam])
  
    // When bots change, only update bots-related state, do not reset name and mode
  useEffect(() => {
    if (formTeam) {
      const ids = formTeam.bots
        .filter(b => bots.some(bot => bot.id === b.bot_id))
        .map(b => String(b.bot_id))
      setSelectedBotKeys(ids)
      const leaderBot = formTeam.bots.find(b => b.role === 'leader' && bots.some(bot => bot.id === b.bot_id))
      setLeaderBotId(leaderBot?.bot_id ?? null)
    }
  }, [bots, formTeam])
    // Change Mode
  const handleModeChange = (newMode: 'pipeline' | 'route' | 'coordinate' | 'collaborate') => {
    setMode(newMode)
    setSelectedBotKeys([])
  }
    // Get currently selected agent_name (from leader or selected bot)
  const selectedAgentName = useMemo(() => {
      // No agent_name restriction in pipeline mode
    if (mode === 'pipeline') return null;

      // If leader exists, use leader's agent_name first
    if (leaderBotId !== null) {
      const leaderBot = bots.find(b => b.id === leaderBotId);
      if (leaderBot) return leaderBot.agent_name;
    }

      // If no leader but selected bot exists, use first selected bot's agent_name
    if (selectedBotKeys.length > 0) {
      const firstSelectedBot = bots.find(b => String(b.id) === selectedBotKeys[0]);
      if (firstSelectedBot) return firstSelectedBot.agent_name;
    }

      // No selection, return null
    return null;
  }, [mode, leaderBotId, selectedBotKeys, bots]);

  const isClaudeCodeAgent = useCallback((agentName?: string | null) => {
    if (!agentName) return false
    const normalized = agentName.trim().toLowerCase()
    return normalized === 'claudecode' || normalized === 'claude_code_agent' || normalized === 'claudecodeagent'
  }, [])

  const hasClaudeCodeBot = useMemo(() => {
    const leaderBot = leaderBotId != null ? bots.find(b => b.id === leaderBotId) : null
    if (leaderBot && isClaudeCodeAgent(leaderBot.agent_name)) {
      return true
    }
    return selectedBotKeys.some(key => {
      const bot = bots.find(b => String(b.id) === key)
      return bot ? isClaudeCodeAgent(bot.agent_name) : false
    })
  }, [bots, leaderBotId, selectedBotKeys, isClaudeCodeAgent])

  useEffect(() => {
    if (hasClaudeCodeBot && mode !== 'pipeline') {
      setMode('pipeline')
    }
  }, [hasClaudeCodeBot, mode])


    // Data source for Transfer
  const transferData = useMemo(
    () => {
      return bots.map(b => ({
        key: String(b.id),
        title: b.name,
        description: b.agent_name,
        disabled:
            // In non-pipeline mode, disable options not matching agent_name if already selected
          mode !== 'pipeline' &&
          selectedAgentName !== null &&
          b.agent_name !== selectedAgentName
      }))
    },
    [bots, mode, selectedAgentName]
  )

    // Transfer change
  const onTransferChange = (targetKeys: React.Key[], direction: TransferDirection, moveKeys: React.Key[]) => {
    if (direction === 'right') {
      setSelectedBotKeys([...new Set(selectedBotKeys.concat(moveKeys))]);
      return;
    }
    setSelectedBotKeys(targetKeys);
  }
    // Leader change
  const onLeaderChange = (botId: number) => {
      // If new leader is in selected bots, remove it from selected bots
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId))
    }

    setLeaderBotId(botId)

      // In non-pipeline mode, filter selected bots by new leader's agent_name
    if (mode !== 'pipeline') {
      const leaderBot = bots.find(b => b.id === botId);
      if (leaderBot) {
          // Filter out selected bots not matching agent_name
        setSelectedBotKeys(prev =>
          prev.filter(key => {
            const bot = bots.find(b => String(b.id) === key);
            return bot && bot.agent_name === leaderBot.agent_name;
          })
        );
      }
    }
  }

  const handleEditBot = useCallback((botId: number) => {
    setDrawerMode('edit')
    setCloningBot(null)
    setEditingBotId(botId)
    setEditingBotDrawerVisible(true)
  }, [])

  const handleCreateBot = useCallback(() => {
    setDrawerMode('edit')
    setCloningBot(null)
    setEditingBotId(0)
    setEditingBotDrawerVisible(true)
  }, [])

  const handleCloneBot = useCallback((botId: number) => {
    const botToClone = bots.find(b => b.id === botId)
    if (!botToClone) {
      return
    }
    setDrawerMode('edit')
    setCloningBot(botToClone)
    setEditingBotId(0)
    setEditingBotDrawerVisible(true)
  }, [bots])
    // Validate agent_name consistency (required in non-pipeline mode)
  const validateAgentNameConsistency = (ids: number[]) => {
    const selected = bots.filter(b => ids.includes(b.id))
    const agentNames = Array.from(new Set(selected.map(b => b.agent_name)))
    return agentNames.length <= 1
  }

    // Save
  const handleSave = async () => {
    if (!name.trim()) {
      message.error('Team name is required')
      return
    }
    if (leaderBotId == null) {
      message.error('Leader bot is required')
      return
    }
    const selectedIds = selectedBotKeys.map(k => Number(k))

      // Non-pipeline mode requires agent_name consistency
    if (mode !== 'pipeline') {
      if (!validateAgentNameConsistency(selectedIds)) {
        message.error('Only bots with the same agent_name can be selected in non-Pipeline mode')
        return
      }
    }

    // Assemble bots data (per-step prompt not supported, all prompts empty)
    // Ensure leader bot is first, others follow transfer order
    let allBotIds: number[] = [];

    // Add leader bot first (if any)
    if (leaderBotId !== null) {
      allBotIds.push(leaderBotId);
    }

    // Then add other bots, avoid duplicate leader bot
    selectedIds.forEach(id => {
      if (id !== leaderBotId) {
        allBotIds.push(id);
      }
    });

    // Create botsData, keep allBotIds order, retain original bot_prompt or use unsaved prompts
    const botsData = allBotIds.map(id => {
      // If editing existing team, keep bot_prompt if bot_id exists
      const existingBot = formTeam?.bots.find(b => b.bot_id === id);
      // Check for unsaved prompt
      const unsavedPrompt = unsavedPrompts[`prompt-${id}`];
      
      return {
        bot_id: id,
        bot_prompt: unsavedPrompt || existingBot?.bot_prompt || '',
        role: id === leaderBotId ? 'leader' : undefined,
      };
    });

    const workflow = { mode, leader_bot_id: leaderBotId }

    setSaving(true)
    try {
      if (editingTeam && editingTeamId && editingTeamId > 0) {
        const updated = await updateTeam(editingTeamId, {
          name: name.trim(),
          workflow,
          bots: botsData
        })
        setTeams(prev => prev.map(team => team.id === updated.id ? updated : team))
      } else {
        const created = await createTeam({
          name: name.trim(),
          workflow,
          bots: botsData
        })
        setTeams(prev => [created, ...prev])
      }
      // Clear unsaved prompts
      setUnsavedPrompts({})
      setEditingTeamId(null)
    } catch (e: any) {
      message.error(e?.message || (editingTeam ? 'Failed to edit team' : 'Failed to create team'))
    } finally {
      setSaving(false)
    }
  }

  // Leader dropdown options, filter by agent_name in non-pipeline mode
  const leaderOptions = useMemo(
    () => {
      // Show all bots in pipeline mode
      if (mode === 'pipeline') return bots;

      // If non-pipeline mode and selected bot exists
      if (selectedBotKeys.length > 0) {
        // Find first selected bot
        const firstSelectedBot = bots.find(b => String(b.id) === selectedBotKeys[0]);
        if (firstSelectedBot) {
          // Show only bots with same agent_name
          return bots.filter(b => b.agent_name === firstSelectedBot.agent_name);
        }
      }

      // Show all bots if no selected bot
      return bots;
    },
    [bots, mode, selectedBotKeys]
  )

  const handleTeamUpdate = (updatedTeam: Team) => {
    setTeams(prev => prev.map(t => t.id === updatedTeam.id ? updatedTeam : t))
  }


  return (
    <div className="flex flex-col flex-1 min-h-0 items-stretch bg-surface rounded-lg pt-0 pb-4 relative w-full max-w-none px-0 md:px-4">
      {/* Top toolbar: Back + Save */}
      <div className="w-full flex items-center justify-between mb-4 mt-4">
        <button
          onClick={handleBack}
          className="flex items-center text-text-muted hover:text-text-primary text-base"
          title={t('common.back')}
        >
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-1">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common.back')}
        </button>

        <Button
          onClick={handleSave}
          disabled={saving}
          loading={saving}
          type="primary"
        >
          {saving ? (editingTeam ? t('actions.saving') : t('actions.creating')) : t('actions.save')}
        </Button>
      </div>

      {/* Two-column layout: Left (Name, Mode, Description Image), Right (LeaderBot, Bots Transfer) */}
      <div className="w-full flex flex-col md:flex-row gap-6 items-stretch flex-1 py-0 min-h-0">
        {/* Left column */}
        <div className="w-full md:w-2/5 min-w-0 flex flex-col space-y-5 min-w-0">
          {/* Team Name */}
          <div className="flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('team.name')} <span className="text-red-400">*</span>
              </label>
            </div>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('team.name_placeholder')}
              className="w-full px-4 py-1 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base h-9"
            />
          </div>

          {/* Mode component */}
          <div className="flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('team.model')} <span className="text-red-400">*</span>
              </label>
            </div>

            {/* Integrate Mode selection and description into one container */}
            <div className="rounded-md border border-border bg-base p-4 flex flex-col flex-1 min-h-0">
              {/* Mode selection - keep Radio.Group */}
              <div className="mb-3">
                <Radio.Group
                  value={mode}
                  onChange={(e) => handleModeChange(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  options={['pipeline', 'route', 'coordinate', 'collaborate'].map(opt => ({
                    label: t(`team_model.${opt}`),
                    value: opt as any,
                    disabled: hasClaudeCodeBot && opt !== 'pipeline',
                    style: { minWidth: 20, padding: '0 12px', textAlign: 'center' }
                  }))}
                  className="w-full"
                />
              </div>

              {/* Divider */}
              <div className="border-t border-border my-2"></div>

              {/* Mode description */}
              <div className="flex-1 flex flex-col min-h-0">
                <p className="text-sm text-text-secondary">{MODE_INFO.info.desc}</p>

                {MODE_INFO.info.bullets.length > 0 && (
                  <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-text-secondary">
                    {MODE_INFO.info.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}

                <div className="pt-3 rounded-md overflow-hidden flex-1 min-h-0 flex items-stretch justify-start">
                  <Image
                    src={MODE_INFO.info.image}
                    alt={MODE_INFO.info.title}
                    width={640}
                    height={360}
                    className="object-contain w-full h-full max-h-full"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="w-full md:w-3/5 min-w-0 flex flex-col space-y-5 min-h-0">
          <div className="rounded-md border border-border bg-base p-4 flex flex-col flex-1 min-h-0">
            {/* LeaderBot single select */}
            <div className="flex flex-col">
              <div className="flex items-center mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('team.leader')} <span className="text-red-400">*</span>
                </label>
              </div>
              <Select
                showSearch
                value={leaderBotId ?? undefined}
                onChange={onLeaderChange}
                placeholder={t('team.select_leader')}
                suffixIcon={<DownOutlined className="text-text-secondary" />}
                optionFilterProp="title"
                filterOption={(input, option) => {
                  const searchText = typeof option?.title === 'string'
                    ? option.title
                    : ''
                  return searchText.toLowerCase().includes(input.toLowerCase())
                }}
                notFoundContent={
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlusOutlined />}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => {
                      e.stopPropagation()
                      handleCreateBot()
                    }}
                  >
                    {t('bots.new_bot')}
                  </Button>
                }
                className="w-full !min-h-[36px]"
                options={leaderOptions.map((b: Bot) => ({
                  value: b.id,
                  title: `${b.name} ${b.agent_name}`,
                  label: (
                    <div className="flex items-center w-full">
                      <div className="flex min-w-0 flex-1 items-center space-x-2">
                        <RiRobot2Line className="w-4 h-4 text-text-muted" />
                        <Tooltip title={`${b.name} (${b.agent_name})`}>
                          <span className="block truncate">
                            {b.name} <span className="text-text-muted text-xs">({b.agent_name})</span>
                          </span>
                        </Tooltip>
                        {teamPromptMap.get(b.id) && (
                          <Tooltip title={t('team.prompts_badge_tooltip')}>
                            <Tag
                              className="!m-0 !ml-1 !px-1.5 !py-0 text-[11px] leading-4"
                              style={configuredPromptBadgeStyle}
                            >
                              {t('team.prompts_badge')}
                            </Tag>
                          </Tooltip>
                        )}
                      </div>
                      <div
                        className="flex items-center gap-3 ml-3"
                        onMouseDown={e => e.preventDefault()}
                      >
                        <EditOutlined
                          className="text-text-secondary hover:text-text-primary cursor-pointer"
                          onMouseDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.stopPropagation(); // Stop event propagation to avoid triggering selection
                            handleEditBot(b.id)
                          }}
                        />
                        <CopyOutlined
                          className="text-text-secondary hover:text-text-primary cursor-pointer"
                          onMouseDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloneBot(b.id)
                          }}
                        />
                      </div>
                    </div>
                  )
                }))}
                popupMatchSelectWidth={true}
                listHeight={250}
                menuItemSelectedIcon={null}
                dropdownStyle={{ minWidth: '200px' }}
              />
            </div>

            {/* Bots Transfer - consolidated container */}
            <div className="flex flex-col min-h-0 mt-1">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('team.bots')}
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Tooltip title={t('team.prompts_tooltip')}>
                  <Button
                    type="link"
                    size="small"
                    icon={<RiMagicLine className="text-sm" />}
                    className="!px-1.5 !text-primary hover:!text-primary"
                    onClick={() => {
                      setDrawerMode('prompt');
                      setEditingBotDrawerVisible(true);
                    }}
                  >
                    {t('team.prompts_link')}
                  </Button>
                </Tooltip>
                <Tag
                  className="!m-0 !px-2 !py-0 text-xs leading-5"
                  style={promptSummaryStyle}
                >
                  {promptSummary.label}
                </Tag>
              </div>

              {/* Transfer component with flex-1 to fill remaining space */}
              <div className="relative flex-1 min-h-0">
              <Transfer
                oneWay
                dataSource={transferData.filter(item => Number(item.key) !== leaderBotId)}
                targetKeys={selectedBotKeys}
                onChange={onTransferChange}
                render={item => (
                  <div className="flex items-center justify-between w-full">
                    <Tooltip title={`${item.title} (${item.description})`}>
                      <span className="truncate">
                        {item.title}
                        <span className="text-xs text-text-muted">({item.description})</span>
                      </span>
                    </Tooltip>

                    <div className="flex items-center">
                      {teamPromptMap.get(Number(item.key)) && (
                        <Tooltip title={t('team.prompts_badge_tooltip')}>
                          <Tag
                            className="!m-0 !mr-2 !px-1.5 !py-0 text-[11px] leading-4"
                            style={configuredPromptBadgeStyle}
                          >
                            {t('team.prompts_badge')}
                          </Tag>
                        </Tooltip>
                      )}

                      <EditOutlined
                        className="ml-2 text-text-secondary hover:text-text-primary cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation(); // Stop event propagation to avoid triggering selection
                          handleEditBot(Number(item.key))
                        }}
                      />
                      <CopyOutlined
                        className="ml-3 text-text-secondary hover:text-text-primary cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleCloneBot(Number(item.key))
                        }}
                      />
                    </div>
                  </div>
                )}
                titles={[t("team.candidates"), t("team.in_team")]}
                style={{}}
                className="h-full transfer-fill"
                listStyle={{
                  backgroundColor: 'rgb(var(--color-bg-base))',
                  borderColor: 'rgb(var(--color-border))',
                }}
                locale={{
                  itemUnit: 'item',
                  itemsUnit: 'items',
                  notFoundContent: t("team.no_data"),
                }}
                footer={(_, info) => {
                  if (info?.direction === 'left') {
                    return (
                      <div className="p-2 text-center">
                        <Button
                          type="primary"
                          size="small"
                          className="w-70"
                          icon={<PlusOutlined />}
                          onClick={() => {
                            handleCreateBot()
                          }}
                        >
                          {t('bots.new_bot')}
                        </Button>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              </div>
            </div>
          </div>
          {/* Mobile Transfer layout optimization styles */}
          <style dangerouslySetInnerHTML={{
            __html: `
              @media (max-width: 640px) {
                .ant-transfer {
                  display: flex !important;
                  flex-direction: column !important;
                  gap: 16px !important;
                  align-items: stretch !important;
                }
                .ant-transfer .ant-transfer-list {
                  width: 100% !important;
                  flex: 1 !important;
                }
                .ant-transfer .ant-transfer-operation {
                  order: 0 !important;
                  justify-content: center !important;
                  align-items: center !important;
                  padding: 12px 0 !important;
                  background-color: transparent !important;
                }
                .ant-transfer .ant-transfer-operation .ant-btn {
                  margin: 0 !important;
                }
              }
            `
          }} />

          {/* Additional scroll and width fix styles */}
          <style dangerouslySetInnerHTML={{
            __html: `
      /* Ensure Transfer component doesn't overflow horizontally on mobile */
      @media (max-width: 640px) {
        .ant-transfer-list {
          max-width: 100% !important;
          overflow-x: hidden !important;
        }
        /* Mobile: Limit list body height to avoid taking full screen */
        .ant-transfer-list-body {
          overflow-y: auto !important;
          max-height: 250px !important;
        }
        /* Ensure minimum height for Transfer container */
        .transfer-fill {
          min-height: 400px !important;
        }
      }
    `
          }} />
          {/* Desktop Transfer layout tidy-up */}
          <style
            dangerouslySetInnerHTML={{
              __html: `
        /* Desktop: equal widths and no overflow */
        @media (min-width: 641px) {
          .ant-transfer { align-items: stretch !important; }
          .ant-transfer .ant-transfer-list { width: calc(50% - 24px) !important; }
          .ant-transfer .ant-transfer-operation { padding: 0 8px !important; }
          .ant-transfer .ant-transfer-list-header { padding: 6px 10px !important; }
        }

        /* PC Transfer fixed height and scroll */
        @media (min-width: 641px) {
          /* Set fixed height for Transfer component */
          .transfer-fill .ant-transfer {
            height: 350px !important;
            display: flex !important;
            flex-direction: column !important;
          }
          .transfer-fill .ant-transfer-list {
            height: 350px !important;
            display: flex !important;
            flex-direction: column !important;
            border: 1px solid rgb(var(--color-border)) !important;
            border-radius: 6px !important;
          }
          /* Ensure list header has fixed height */
          .transfer-fill .ant-transfer-list-header {
            flex-shrink: 0 !important;
            height: 40px !important;
            padding: 8px 12px !important;
          }
          /* Set fixed height and scroll for list body */
          .transfer-fill .ant-transfer-list-body {
            flex: 1 !important;
            overflow-y: auto !important;
            overflow-x: hidden !important;
            min-height: 200px !important;
            max-height: 360px !important;
          }
          /* Ensure list footer has fixed height (if any) */
          .transfer-fill .ant-transfer-list-footer {
            flex-shrink: 0 !important;
            padding: 8px 12px !important;
          }
        }

        /* Normalize small typography paddings for tight, neat look */
        .ant-select .ant-select-selector { min-height: 36px; }
        .ant-tag { line-height: 20px; }
      `,
            }}
          />
        </div>
      </div>

      {/* Bot edit drawer */}
      <TeamEditDrawer
        bots={bots}
        setBots={setBots}
        editingBotId={editingBotId}
        setEditingBotId={setEditingBotId}
        visible={editingBotDrawerVisible}
        setVisible={setEditingBotDrawerVisible}
        message={message}
        mode={drawerMode}
        editingTeam={editingTeam}
        onTeamUpdate={handleTeamUpdate}
        cloningBot={cloningBot}
        setCloningBot={setCloningBot}
        selectedBotKeys={selectedBotKeys}
        leaderBotId={leaderBotId}
        unsavedPrompts={unsavedPrompts}
        setUnsavedPrompts={setUnsavedPrompts}
      />
    </div>
  )
}
