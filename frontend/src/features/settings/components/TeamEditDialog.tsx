// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { AlertCircle, Loader2 } from 'lucide-react'

import type { SkillRefMeta } from '@/apis/bots'
import { botApis } from '@/apis/bots'
import { modelApis, type ModelTypeEnum, type UnifiedModel } from '@/apis/models'
import { fetchUnifiedSkillsList, type UnifiedSkill } from '@/apis/skills'
import {
  Bot,
  Team,
  TaskType,
  type KnowledgeBaseDefaultRef,
  type PipelineContextPassing,
} from '@/types/api'
import {
  TeamMode,
  getAllowedAgentsForTeamMode,
  getFilteredBotsForMode,
  AgentType,
  getActualShellType,
} from './team-modes'
import { createTeam, updateTeam } from '../services/teams'
import TeamEditDrawer from './TeamEditDrawer'
import { useTranslation } from '@/hooks/useTranslation'
import { shellApis, UnifiedShell } from '@/apis/shells'
import { BotEditRef } from './BotEdit'
import { useTeamContext } from '@/contexts/TeamContext'
import { filterVisibleSkills } from '@/utils/skillVisibility'

// Import sub-components
import TeamBasicInfoForm from './team-edit/TeamBasicInfoForm'
import TeamModeSelector from './team-edit/TeamModeSelector'
import TeamModeEditor from './team-edit/TeamModeEditor'
import TeamModeChangeDialog from './team-edit/TeamModeChangeDialog'
import SimpleTeamEditForm from './team-edit/SimpleTeamEditForm'
import {
  bindModeRequiresClaudeCode,
  getDefaultSimpleBindMode,
  isClaudeCodeShell,
  normalizeExecutorForBindMode,
  resolveShellForExecutor,
  shellSupportsPreloadSkills,
  type SimpleExecutorMode,
} from './team-edit/simple-team-edit-utils'
import { buildSimpleBotRequest, buildSimpleTeamRequest } from './team-edit/simple-team-edit-save'
import {
  getModelFromConfig,
  getModelNamespaceFromConfig,
  getModelTypeFromConfig,
} from '../services/bots'
import { getAllowedAgentsForBindMode } from '../utils/team-bind-mode-rules'
import { normalizeMcpServers, parseMcpConfig, stringifyMcpConfig } from '../utils/mcpConfig'
import type { AgentType as McpAgentType } from '../utils/mcpTypeAdapter'

interface TeamEditDialogProps {
  open: boolean
  onClose: () => void
  teams: Team[]
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>
  editingTeamId: number | null
  initialTeam?: Team | null
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
}

const SIMPLE_BIND_MODES = new Set<TaskType>(['chat', 'code', 'task'])

function getQuickPhrasePayload(phrases: string[]): string[] {
  return phrases.map(phrase => phrase.trim()).filter(Boolean)
}

function normalizeSimpleBindMode(team: Team): TaskType[] {
  if (team.bind_mode && Array.isArray(team.bind_mode)) {
    const supportedModes = team.bind_mode.filter(mode => SIMPLE_BIND_MODES.has(mode))
    return supportedModes.length > 0 ? supportedModes : getDefaultSimpleBindMode()
  }

  const recommendedMode =
    team.recommended_mode ||
    (team.workflow?.recommended_mode as 'chat' | 'code' | 'both' | undefined)

  if (recommendedMode === 'code') {
    return ['code']
  }

  return getDefaultSimpleBindMode()
}

function getInitialBindMode(team: Team): TaskType[] {
  if (team.bind_mode && Array.isArray(team.bind_mode) && team.bind_mode.length > 0) {
    const hasNonSimpleMode = team.bind_mode.some(mode => !SIMPLE_BIND_MODES.has(mode))
    return hasNonSimpleMode ? team.bind_mode : normalizeSimpleBindMode(team)
  }

  return normalizeSimpleBindMode(team)
}

function resolveSimpleExecutorFromBot(bot: Bot | undefined): {
  mode: SimpleExecutorMode
  customShellName: string
} {
  if (!bot) {
    return { mode: 'simple', customShellName: '' }
  }

  if (bot.shell_type === 'ClaudeCode' || bot.shell_name === 'ClaudeCode') {
    return { mode: 'complex', customShellName: '' }
  }

  if (bot.shell_type === 'Chat' || bot.shell_name === 'Chat') {
    return { mode: 'simple', customShellName: '' }
  }

  return { mode: 'custom', customShellName: bot.shell_name }
}

export default function TeamEditDialog(props: TeamEditDialogProps) {
  const {
    open,
    onClose,
    teams,
    setTeams,
    editingTeamId,
    initialTeam = null,
    bots,
    setBots,
    toast,
    scope = 'personal',
    groupName,
  } = props

  const { t } = useTranslation()
  const { refreshTeams } = useTeamContext()

  // Current editing object (0 means create new)
  const editingTeam: Team | null =
    editingTeamId === 0 ? null : teams.find(t => t.id === editingTeamId) || null

  const formTeam = editingTeam ?? (editingTeamId === 0 ? initialTeam : null) ?? null

  // Form state
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [quickPhrases, setQuickPhrases] = useState<string[]>([])
  const [mode, setMode] = useState<TeamMode>('solo')
  const [bindMode, setBindMode] = useState<TaskType[]>(['chat', 'code'])
  const [icon, setIcon] = useState<string | null>(null)
  const [requiresWorkspace, setRequiresWorkspace] = useState<boolean | null>(null)

  // Bot selection state
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

  // Store requireConfirmation settings for pipeline mode (botId -> boolean)
  const [requireConfirmationMap, setRequireConfirmationMap] = useState<Record<number, boolean>>({})
  const [contextPassingMap, setContextPassingMap] = useState<
    Record<number, PipelineContextPassing>
  >({})

  // Mode change confirmation dialog state
  const [modeChangeDialogVisible, setModeChangeDialogVisible] = useState(false)
  const [pendingMode, setPendingMode] = useState<TeamMode | null>(null)

  // Shells data for resolving custom shell runtime types
  const [shells, setShells] = useState<UnifiedShell[]>([])

  // Simplified editor state
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [simpleExecutorMode, setSimpleExecutorMode] = useState<SimpleExecutorMode>('simple')
  const [simpleCustomShellName, setSimpleCustomShellName] = useState('')
  const [simpleBotName, setSimpleBotName] = useState('')
  const [simpleModelName, setSimpleModelName] = useState('')
  const [simpleModelType, setSimpleModelType] = useState<ModelTypeEnum | undefined>(undefined)
  const [simpleModelNamespace, setSimpleModelNamespace] = useState<string | undefined>(undefined)
  const [simplePrompt, setSimplePrompt] = useState('')
  const [simpleSelectedSkills, setSimpleSelectedSkills] = useState<string[]>([])
  const [simpleSelectedSkillRefs, setSimpleSelectedSkillRefs] = useState<
    Record<string, SkillRefMeta>
  >({})
  const [simplePreloadSkills, setSimplePreloadSkills] = useState<string[]>([])
  const [simpleAllSkills, setSimpleAllSkills] = useState<UnifiedSkill[]>([])
  const [simpleAvailableSkills, setSimpleAvailableSkills] = useState<UnifiedSkill[]>([])
  const [simpleLoadingSkills, setSimpleLoadingSkills] = useState(false)
  const [simpleModels, setSimpleModels] = useState<UnifiedModel[]>([])
  const [simpleLoadingModels, setSimpleLoadingModels] = useState(false)
  const [simpleDefaultKnowledgeBaseRefs, setSimpleDefaultKnowledgeBaseRefs] = useState<
    KnowledgeBaseDefaultRef[]
  >([])
  const [simpleMcpConfig, setSimpleMcpConfig] = useState('')

  // Ref for BotEdit in solo mode
  const botEditRef = useRef<BotEditRef | null>(null)

  // Load shells data on mount
  useEffect(() => {
    if (!open) return
    const fetchShells = async () => {
      try {
        const response = await shellApis.getUnifiedShells(scope, groupName)
        setShells(response.data || [])
      } catch (error) {
        console.error('Failed to fetch shells:', error)
      }
    }
    fetchShells()
  }, [open, scope, groupName])

  // Filter bots based on current mode
  const filteredBots = useMemo(() => {
    return getFilteredBotsForMode(bots, mode, shells)
  }, [bots, mode, shells])

  // Get allowed agents for current mode
  const allowedAgentsForMode = useMemo((): AgentType[] | undefined => {
    return getAllowedAgentsForTeamMode(mode)
  }, [mode])

  const effectiveAllowedAgents = useMemo(
    () => getAllowedAgentsForBindMode(bindMode, allowedAgentsForMode),
    [bindMode, allowedAgentsForMode]
  )

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

  const isNonSoloTeam = !!formTeam && mode !== 'solo'
  const useSimpleEditor = !advancedOpen && !isNonSoloTeam

  const selectedSimpleShell = useMemo(
    () => resolveShellForExecutor(shells, simpleExecutorMode, simpleCustomShellName),
    [shells, simpleCustomShellName, simpleExecutorMode]
  )

  const simpleMcpAgentType = useMemo<McpAgentType | undefined>(() => {
    const shellType = selectedSimpleShell?.shellType || selectedSimpleShell?.name
    return shellType === 'ClaudeCode' || shellType === 'Agno' ? shellType : undefined
  }, [selectedSimpleShell])
  const simpleSupportsPreloadSkills = useMemo(() => {
    return shellSupportsPreloadSkills(selectedSimpleShell)
  }, [selectedSimpleShell])

  const simpleExecutorNeedsComplex = bindModeRequiresClaudeCode(bindMode)
  const simpleExecutorHelperText = simpleExecutorNeedsComplex
    ? t('settings:team.simple.executor.requires_complex_hint')
    : null
  const skillLoadingFailedTitle = t('common:skills.loading_failed')
  const modelLoadingFailedTitle = t('common:bot.errors.fetch_models_failed')

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return

    if (formTeam) {
      setName(formTeam.name)
      setDisplayName(formTeam.displayName || '')
      setDescription(formTeam.description || '')
      setQuickPhrases(formTeam.quick_phrases || [])
      setIcon(formTeam.icon || null)
      const m = (formTeam.workflow?.mode as TeamMode) || 'solo'
      setMode(m)
      setAdvancedOpen(m !== 'solo')
      setBindMode(getInitialBindMode(formTeam))
      const ids = formTeam.bots.map(b => String(b.bot_id))
      setSelectedBotKeys(ids)
      const leaderBot = formTeam.bots.find(b => b.role === 'leader') || formTeam.bots[0]
      setLeaderBotId(leaderBot?.bot_id ?? null)
      const fullLeaderBot = bots.find(bot => bot.id === leaderBot?.bot_id)
      const executor = resolveSimpleExecutorFromBot(fullLeaderBot)
      setSimpleExecutorMode(executor.mode)
      setSimpleCustomShellName(executor.customShellName)
      setSimpleBotName(fullLeaderBot?.name || '')
      setSimplePrompt(fullLeaderBot?.system_prompt || '')
      setSimpleSelectedSkills(fullLeaderBot?.skills || [])
      setSimpleSelectedSkillRefs(fullLeaderBot?.skill_refs || {})
      setSimplePreloadSkills(fullLeaderBot?.preload_skills || [])
      setSimpleDefaultKnowledgeBaseRefs(fullLeaderBot?.default_knowledge_base_refs || [])
      setSimpleMcpConfig(stringifyMcpConfig(fullLeaderBot?.mcp_servers || {}))
      setSimpleModelName(
        fullLeaderBot?.agent_config ? getModelFromConfig(fullLeaderBot.agent_config) : ''
      )
      setSimpleModelType(
        fullLeaderBot?.agent_config ? getModelTypeFromConfig(fullLeaderBot.agent_config) : undefined
      )
      setSimpleModelNamespace(
        fullLeaderBot?.agent_config
          ? getModelNamespaceFromConfig(fullLeaderBot.agent_config)
          : undefined
      )
      // Initialize requireConfirmationMap from existing team data
      const confirmMap: Record<number, boolean> = {}
      const passingMap: Record<number, PipelineContextPassing> = {}
      formTeam.bots.forEach(b => {
        if (b.requireConfirmation) {
          confirmMap[b.bot_id] = true
        }
        if (b.contextPassing && b.contextPassing !== 'none') {
          passingMap[b.bot_id] = b.contextPassing
        }
      })
      setRequireConfirmationMap(confirmMap)
      setContextPassingMap(passingMap)
      // Initialize requiresWorkspace from existing team data
      // Default to true for legacy data that doesn't have this field
      setRequiresWorkspace(formTeam.requires_workspace ?? true)
    } else {
      setName('')
      setDisplayName('')
      setDescription('')
      setQuickPhrases([])
      setIcon(null)
      setMode('solo')
      setAdvancedOpen(false)
      setBindMode(getDefaultSimpleBindMode())
      setSelectedBotKeys([])
      setLeaderBotId(null)
      setRequireConfirmationMap({})
      setContextPassingMap({})
      setSimpleExecutorMode('simple')
      setSimpleCustomShellName('')
      setSimpleBotName('')
      setSimpleModelName('')
      setSimpleModelType(undefined)
      setSimpleModelNamespace(undefined)
      setSimplePrompt('')
      setSimpleSelectedSkills([])
      setSimpleSelectedSkillRefs({})
      setSimplePreloadSkills([])
      setSimpleDefaultKnowledgeBaseRefs([])
      setSimpleMcpConfig('')
      // Default to true for new teams (requires workspace by default)
      setRequiresWorkspace(true)
    }
    setUnsavedPrompts({})
  }, [bots, formTeam, open])

  // Update bot selection when bots change
  useEffect(() => {
    if (!open || !formTeam) return

    const ids = formTeam.bots
      .filter(b => filteredBots.some((bot: Bot) => bot.id === b.bot_id))
      .map(b => String(b.bot_id))
    setSelectedBotKeys(ids)
    const leaderBot = formTeam.bots.find(
      b => b.role === 'leader' && filteredBots.some((bot: Bot) => bot.id === b.bot_id)
    )
    setLeaderBotId(leaderBot?.bot_id ?? null)
  }, [open, filteredBots, formTeam])

  useEffect(() => {
    if (!useSimpleEditor) return

    const normalized = normalizeExecutorForBindMode(
      simpleExecutorMode,
      bindMode,
      shells,
      simpleCustomShellName
    )

    if (normalized.mode !== simpleExecutorMode) {
      setSimpleExecutorMode(normalized.mode)
    }
  }, [bindMode, shells, simpleCustomShellName, simpleExecutorMode, useSimpleEditor])

  const reloadSimpleSkills = useCallback(async () => {
    if (!useSimpleEditor) return

    setSimpleLoadingSkills(true)
    try {
      const skills = await fetchUnifiedSkillsList({ scope, groupName })
      setSimpleAllSkills(skills)
      setSimpleAvailableSkills(filterVisibleSkills(skills))
    } catch {
      toast({
        variant: 'destructive',
        title: skillLoadingFailedTitle,
      })
    } finally {
      setSimpleLoadingSkills(false)
    }
  }, [groupName, scope, skillLoadingFailedTitle, toast, useSimpleEditor])

  useEffect(() => {
    if (!open || !useSimpleEditor) return
    reloadSimpleSkills()
  }, [open, reloadSimpleSkills, useSimpleEditor])

  useEffect(() => {
    if (!open || !useSimpleEditor || !selectedSimpleShell) return

    let cancelled = false

    const fetchModels = async () => {
      setSimpleLoadingModels(true)
      try {
        const shellType = selectedSimpleShell.shellType || selectedSimpleShell.name
        const response = await modelApis.getUnifiedModels(shellType, false, scope, groupName, 'llm')
        if (!cancelled) {
          setSimpleModels(response.data)
        }
      } catch {
        if (!cancelled) {
          setSimpleModels([])
          toast({
            variant: 'destructive',
            title: modelLoadingFailedTitle,
          })
        }
      } finally {
        if (!cancelled) {
          setSimpleLoadingModels(false)
        }
      }
    }

    fetchModels()

    return () => {
      cancelled = true
    }
  }, [groupName, modelLoadingFailedTitle, open, scope, selectedSimpleShell, toast, useSimpleEditor])

  // Check if mode change needs confirmation
  const needsModeChangeConfirmation = useCallback(() => {
    const hasSelectedBots = selectedBotKeys.length > 0 || leaderBotId !== null
    const hasUnsavedPrompts = Object.values(unsavedPrompts).some(
      value => (value ?? '').trim().length > 0
    )
    const hasExistingPrompts =
      formTeam?.bots.some(bot => bot.bot_prompt && bot.bot_prompt.trim().length > 0) ?? false

    return hasSelectedBots || hasUnsavedPrompts || hasExistingPrompts
  }, [selectedBotKeys, leaderBotId, unsavedPrompts, formTeam])

  // Execute mode change with reset
  const executeModeChange = useCallback((newMode: TeamMode) => {
    setMode(newMode)
    setSelectedBotKeys([])
    setLeaderBotId(null)
    setUnsavedPrompts({})
    setRequireConfirmationMap({})
    setContextPassingMap({})
  }, [])

  // Change Mode with confirmation
  const handleModeChange = (newMode: TeamMode) => {
    if (newMode === mode) return

    if (needsModeChangeConfirmation()) {
      setPendingMode(newMode)
      setModeChangeDialogVisible(true)
    } else {
      executeModeChange(newMode)
    }
  }

  const handleConfirmModeChange = () => {
    if (pendingMode) {
      executeModeChange(pendingMode)
    }
    setModeChangeDialogVisible(false)
    setPendingMode(null)
  }

  const handleCancelModeChange = () => {
    setModeChangeDialogVisible(false)
    setPendingMode(null)
  }

  const isDifyLeader = useMemo(() => {
    if (leaderBotId === null) return false
    const leader = filteredBots.find((b: Bot) => b.id === leaderBotId)
    return leader?.shell_type === 'Dify'
  }, [leaderBotId, filteredBots])

  // Build shell map for looking up actual shell types
  const shellMap = useMemo(() => {
    const map = new Map<string, UnifiedShell>()
    shells.forEach(shell => map.set(shell.name, shell))
    return map
  }, [shells])

  // Leader change handler
  const onLeaderChange = (botId: number) => {
    // If new Leader is in selected members, remove it first
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId))
    }

    const newLeader = filteredBots.find((b: Bot) => b.id === botId)

    // Dify Leader does not support members
    if (newLeader?.shell_type === 'Dify') {
      setSelectedBotKeys([])
      setLeaderBotId(botId)
      return
    }

    // Get the new Leader's actual shell type
    const newLeaderShellType = getActualShellType(newLeader?.shell_type || '', shellMap)

    // Clear all selected members that are incompatible with the new Leader type
    setSelectedBotKeys(prev =>
      prev.filter(key => {
        const bot = bots.find(b => b.id === Number(key))
        if (!bot) return false
        const botShellType = getActualShellType(bot.shell_type, shellMap)
        return botShellType === newLeaderShellType
      })
    )

    setLeaderBotId(botId)
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

  const handleCloneBot = useCallback(
    (botId: number) => {
      const botToClone = filteredBots.find((b: Bot) => b.id === botId)
      if (!botToClone) return
      setDrawerMode('edit')
      setCloningBot(botToClone)
      setEditingBotId(0)
      setEditingBotDrawerVisible(true)
    },
    [filteredBots]
  )

  const handleOpenPromptDrawer = useCallback(() => {
    setDrawerMode('prompt')
    setEditingBotDrawerVisible(true)
  }, [])

  const handleTeamUpdate = (updatedTeam: Team) => {
    setTeams(prev => prev.map(t => (t.id === updatedTeam.id ? updatedTeam : t)))
  }

  const handleSimpleSave = async () => {
    const selectedShell = resolveShellForExecutor(shells, simpleExecutorMode, simpleCustomShellName)
    if (!selectedShell) {
      toast({
        variant: 'destructive',
        title: t('settings:team.simple.executor.required'),
      })
      return
    }

    if (bindModeRequiresClaudeCode(bindMode) && !isClaudeCodeShell(selectedShell)) {
      toast({
        variant: 'destructive',
        title: t('settings:team.simple.executor.requires_complex_hint'),
      })
      return
    }

    const namespace = scope === 'group' && groupName ? groupName : undefined
    const existingLeaderBotId =
      formTeam?.bots.find(bot => bot.role === 'leader')?.bot_id ?? formTeam?.bots[0]?.bot_id
    let parsedMcpServers: Record<string, unknown> = {}

    if (simpleMcpConfig.trim()) {
      try {
        parsedMcpServers = normalizeMcpServers(parseMcpConfig(simpleMcpConfig), simpleMcpAgentType)
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
        return
      }
    }

    const botRequest = {
      ...buildSimpleBotRequest(
        {
          name: simpleBotName,
          shellName: selectedShell.name,
          modelName: simpleModelName,
          modelType: simpleModelType,
          modelNamespace: simpleModelNamespace,
          prompt: simplePrompt,
          selectedSkills: simpleSelectedSkills,
          selectedSkillRefs: simpleSelectedSkillRefs,
          preloadSkills: simpleSupportsPreloadSkills ? simplePreloadSkills : [],
          availableSkills: simpleAllSkills,
          defaultKnowledgeBaseRefs: simpleDefaultKnowledgeBaseRefs,
          mcpServers: parsedMcpServers,
        },
        name,
        scope,
        groupName
      ),
      namespace,
    }
    const trimmedDisplayName = displayName.trim()
    const displayNamePayload = trimmedDisplayName || (formTeam?.displayName ? null : undefined)

    setSaving(true)
    try {
      const savedBot =
        existingLeaderBotId && editingTeamId && editingTeamId > 0
          ? await botApis.updateBot(existingLeaderBotId, botRequest)
          : await botApis.createBot(botRequest)

      setBots(prev => {
        const exists = prev.some(bot => bot.id === savedBot.id)
        return exists
          ? prev.map(bot => (bot.id === savedBot.id ? savedBot : bot))
          : [savedBot, ...prev]
      })

      const teamRequest = buildSimpleTeamRequest(
        {
          name,
          displayName,
          description,
          quickPhrases,
          bindMode,
          icon,
          requiresWorkspace,
          namespace,
        },
        savedBot.id
      )
      teamRequest.displayName = displayNamePayload

      if (editingTeam && editingTeamId && editingTeamId > 0) {
        const updated = await updateTeam(editingTeamId, teamRequest)
        setTeams(prev => prev.map(team => (team.id === updated.id ? updated : team)))
      } else {
        const created = await createTeam(teamRequest)
        setTeams(prev => [created, ...prev])
      }

      refreshTeams().catch(err => console.error('Failed to refresh teams after save:', err))
      setUnsavedPrompts({})
      onClose()
    } catch (error) {
      toast({
        variant: 'destructive',
        title:
          (error as Error)?.message ||
          (editingTeam ? t('common:teams.edit_failed') : t('common:teams.create_failed')),
      })
    } finally {
      setSaving(false)
    }
  }

  // Save handler
  const handleSave = async () => {
    if (!name.trim()) {
      toast({
        variant: 'destructive',
        title: t('common:team.name_required'),
      })
      return
    }

    // Validate bind_mode is not empty
    if (bindMode.length === 0) {
      toast({
        variant: 'destructive',
        title: t('team.bind_mode_required'),
      })
      return
    }

    if (useSimpleEditor) {
      await handleSimpleSave()
      return
    }

    const trimmedDisplayName = displayName.trim()
    const displayNamePayload = trimmedDisplayName || (formTeam?.displayName ? null : undefined)
    const quickPhrasePayload = getQuickPhrasePayload(quickPhrases)

    // For solo mode, save bot first via BotEdit ref
    if (mode === 'solo') {
      if (botEditRef.current) {
        const validation = botEditRef.current.validateBot()
        if (!validation.isValid) {
          toast({
            variant: 'destructive',
            title: validation.error || t('common:bot.errors.required'),
          })
          return
        }

        setSaving(true)
        try {
          const savedBotId = await botEditRef.current.saveBot()
          if (savedBotId === null) {
            setSaving(false)
            return
          }

          const botsData = [
            {
              bot_id: savedBotId,
              bot_prompt: unsavedPrompts[`prompt-${savedBotId}`] || '',
              role: 'leader',
            },
          ]

          const workflow = { mode, leader_bot_id: savedBotId }

          if (editingTeam && editingTeamId && editingTeamId > 0) {
            const updated = await updateTeam(editingTeamId, {
              name: name.trim(),
              displayName: displayNamePayload,
              description: description.trim() || undefined,
              workflow,
              bind_mode: bindMode,
              bots: botsData,
              quick_phrases: quickPhrasePayload,
              namespace: scope === 'group' && groupName ? groupName : undefined,
              icon: icon || undefined,
              requires_workspace: requiresWorkspace ?? undefined,
            })
            setTeams(prev => prev.map(team => (team.id === updated.id ? updated : team)))
          } else {
            const created = await createTeam({
              name: name.trim(),
              displayName: displayNamePayload,
              description: description.trim() || undefined,
              workflow,
              bind_mode: bindMode,
              bots: botsData,
              quick_phrases: quickPhrasePayload,
              namespace: scope === 'group' && groupName ? groupName : undefined,
              icon: icon || undefined,
              requires_workspace: requiresWorkspace ?? undefined,
            })
            setTeams(prev => [created, ...prev])
          }

          // Refresh TeamContext so Chat page gets updated bot agent_config
          refreshTeams().catch(err => console.error('Failed to refresh teams after save:', err))

          setUnsavedPrompts({})
          onClose()
        } catch (error) {
          toast({
            variant: 'destructive',
            title:
              (error as Error)?.message ||
              (editingTeam ? t('common:teams.edit_failed') : t('common:teams.create_failed')),
          })
        } finally {
          setSaving(false)
        }
        return
      }
    }

    // Non-solo mode - require leaderBotId
    if (leaderBotId == null) {
      toast({
        variant: 'destructive',
        title: mode === 'solo' ? t('common:team.bot_required') : t('common:team.leader_required'),
      })
      return
    }

    const selectedIds = mode === 'solo' ? [] : selectedBotKeys.map(k => Number(k))
    const allBotIds: number[] = []

    if (leaderBotId !== null) {
      allBotIds.push(leaderBotId)
    }

    if (mode !== 'solo' && !isDifyLeader) {
      selectedIds.forEach(id => {
        if (id !== leaderBotId) {
          allBotIds.push(id)
        }
      })
    }

    const finalPipelineBotId = mode === 'pipeline' ? allBotIds[allBotIds.length - 1] : null

    const botsData = allBotIds.map(id => {
      const existingBot = formTeam?.bots.find(b => b.bot_id === id)
      const unsavedPrompt = unsavedPrompts[`prompt-${id}`]
      const isFinalPipelineBot = id === finalPipelineBotId

      return {
        bot_id: id,
        bot_prompt: unsavedPrompt || existingBot?.bot_prompt || '',
        role: id === leaderBotId ? 'leader' : undefined,
        // Include requireConfirmation for pipeline mode
        requireConfirmation:
          mode === 'pipeline'
            ? !isFinalPipelineBot && (requireConfirmationMap[id] || false)
            : undefined,
        contextPassing:
          mode === 'pipeline'
            ? isFinalPipelineBot
              ? 'none'
              : contextPassingMap[id] || 'none'
            : undefined,
      }
    })

    const workflow = { mode, leader_bot_id: leaderBotId }

    setSaving(true)
    try {
      if (editingTeam && editingTeamId && editingTeamId > 0) {
        const updated = await updateTeam(editingTeamId, {
          name: name.trim(),
          displayName: displayNamePayload,
          description: description.trim() || undefined,
          workflow,
          bind_mode: bindMode,
          bots: botsData,
          quick_phrases: quickPhrasePayload,
          namespace: scope === 'group' && groupName ? groupName : undefined,
          icon: icon || undefined,
          requires_workspace: requiresWorkspace ?? undefined,
        })
        setTeams(prev => prev.map(team => (team.id === updated.id ? updated : team)))
      } else {
        const created = await createTeam({
          name: name.trim(),
          displayName: displayNamePayload,
          description: description.trim() || undefined,
          workflow,
          bind_mode: bindMode,
          bots: botsData,
          quick_phrases: quickPhrasePayload,
          namespace: scope === 'group' && groupName ? groupName : undefined,
          icon: icon || undefined,
          requires_workspace: requiresWorkspace ?? undefined,
        })
        setTeams(prev => [created, ...prev])
      }
      // Refresh TeamContext so Chat page gets updated bot agent_config
      refreshTeams().catch(err => console.error('Failed to refresh teams after save:', err))
      setUnsavedPrompts({})
      onClose()
    } catch (error) {
      toast({
        variant: 'destructive',
        title:
          (error as Error)?.message ||
          (editingTeam ? t('common:teams.edit_failed') : t('common:teams.create_failed')),
      })
    } finally {
      setSaving(false)
    }
  }

  const leaderOptions = useMemo(() => filteredBots, [filteredBots])

  const isEditing = editingTeamId !== null && editingTeamId > 0

  return (
    <>
      <Dialog open={open} onOpenChange={open => !open && onClose()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {isEditing ? t('common:teams.edit_title') : t('common:teams.create_title')}
            </DialogTitle>
            <DialogDescription>{t('common:teams.description')}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto py-4 pr-4 [scrollbar-gutter:stable]">
            {!isNonSoloTeam && (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {t('settings:team.simple.advanced_toggle')}
                  </p>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {t('settings:team.simple.advanced_toggle_description')}
                  </p>
                </div>
                <Switch
                  checked={advancedOpen}
                  onCheckedChange={checked => setAdvancedOpen(checked)}
                  data-testid="advanced-mode-switch"
                />
              </div>
            )}

            {useSimpleEditor ? (
              <SimpleTeamEditForm
                name={name}
                setName={setName}
                displayName={displayName}
                setDisplayName={setDisplayName}
                description={description}
                setDescription={setDescription}
                quickPhrases={quickPhrases}
                onQuickPhrasesChange={setQuickPhrases}
                bindMode={bindMode}
                setBindMode={setBindMode}
                icon={icon}
                setIcon={setIcon}
                requiresWorkspace={requiresWorkspace}
                setRequiresWorkspace={setRequiresWorkspace}
                executorMode={simpleExecutorMode}
                setExecutorMode={setSimpleExecutorMode}
                shells={shells}
                customShellName={simpleCustomShellName}
                setCustomShellName={setSimpleCustomShellName}
                executorHelperText={simpleExecutorHelperText}
                disabledExecutorModes={simpleExecutorNeedsComplex ? ['simple'] : []}
                modelName={simpleModelName}
                modelType={simpleModelType}
                modelNamespace={simpleModelNamespace}
                models={simpleModels}
                loadingModels={simpleLoadingModels}
                onModelChange={value => {
                  setSimpleModelName(value.name)
                  setSimpleModelType(value.type)
                  setSimpleModelNamespace(value.namespace)
                }}
                selectedSkills={simpleSelectedSkills}
                selectedSkillRefs={simpleSelectedSkillRefs}
                preloadSkills={simplePreloadSkills}
                onPreloadSkillsChange={setSimplePreloadSkills}
                supportsPreloadSkills={simpleSupportsPreloadSkills}
                availableSkills={simpleAvailableSkills}
                allSkills={simpleAllSkills}
                loadingSkills={simpleLoadingSkills}
                onSkillsChange={(skills, refs) => {
                  setSimpleSelectedSkills(skills)
                  setSimpleSelectedSkillRefs(refs)
                  setSimplePreloadSkills(prev =>
                    prev.filter(skillName => skills.includes(skillName))
                  )
                }}
                onReloadSkills={reloadSimpleSkills}
                defaultKnowledgeBaseRefs={simpleDefaultKnowledgeBaseRefs}
                onDefaultKnowledgeBaseRefsChange={setSimpleDefaultKnowledgeBaseRefs}
                mcpConfig={simpleMcpConfig}
                onMcpConfigChange={setSimpleMcpConfig}
                mcpAgentType={simpleMcpAgentType}
                prompt={simplePrompt}
                onPromptChange={setSimplePrompt}
                toast={toast}
                scope={scope}
                groupName={groupName}
              />
            ) : (
              <>
                {isNonSoloTeam && (
                  <div className="flex items-start gap-2 rounded-md border border-border bg-surface p-3 text-sm text-text-secondary">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{t('settings:team.simple.non_solo_notice')}</span>
                  </div>
                )}

                {/* Basic Info Section */}
                <TeamBasicInfoForm
                  name={name}
                  setName={setName}
                  displayName={displayName}
                  setDisplayName={setDisplayName}
                  description={description}
                  setDescription={setDescription}
                  quickPhrases={quickPhrases}
                  onQuickPhrasesChange={setQuickPhrases}
                  bindMode={bindMode}
                  setBindMode={setBindMode}
                  icon={icon}
                  setIcon={setIcon}
                  requiresWorkspace={requiresWorkspace}
                  setRequiresWorkspace={setRequiresWorkspace}
                />

                {/* Mode Selection Section */}
                <TeamModeSelector mode={mode} onModeChange={handleModeChange} />

                {/* Mode-specific Editor Section */}
                <TeamModeEditor
                  mode={mode}
                  filteredBots={filteredBots}
                  shells={shells}
                  setBots={setBots}
                  selectedBotKeys={selectedBotKeys}
                  setSelectedBotKeys={setSelectedBotKeys}
                  leaderBotId={leaderBotId}
                  setLeaderBotId={setLeaderBotId}
                  editingTeam={editingTeam}
                  editingTeamId={editingTeamId}
                  toast={toast}
                  unsavedPrompts={unsavedPrompts}
                  teamPromptMap={teamPromptMap}
                  isDifyLeader={isDifyLeader}
                  leaderOptions={leaderOptions}
                  allowedAgentsForMode={effectiveAllowedAgents}
                  botEditRef={botEditRef}
                  scope={scope}
                  groupName={groupName}
                  requireConfirmationMap={requireConfirmationMap}
                  setRequireConfirmationMap={setRequireConfirmationMap}
                  contextPassingMap={contextPassingMap}
                  setContextPassingMap={setContextPassingMap}
                  onEditBot={handleEditBot}
                  onCreateBot={handleCreateBot}
                  onCloneBot={handleCloneBot}
                  onOpenPromptDrawer={handleOpenPromptDrawer}
                  onLeaderChange={onLeaderChange}
                />
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving} variant="primary">
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? t('common:actions.saving') : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bot edit drawer */}
      <TeamEditDrawer
        bots={bots}
        setBots={setBots}
        editingBotId={editingBotId}
        setEditingBotId={setEditingBotId}
        visible={editingBotDrawerVisible}
        setVisible={setEditingBotDrawerVisible}
        toast={toast}
        mode={drawerMode}
        editingTeam={editingTeam}
        onTeamUpdate={handleTeamUpdate}
        cloningBot={cloningBot}
        setCloningBot={setCloningBot}
        selectedBotKeys={selectedBotKeys}
        leaderBotId={leaderBotId}
        unsavedPrompts={unsavedPrompts}
        setUnsavedPrompts={setUnsavedPrompts}
        allowedAgents={effectiveAllowedAgents}
        scope={scope}
        groupName={groupName}
      />

      {/* Mode change confirmation dialog */}
      <TeamModeChangeDialog
        open={modeChangeDialogVisible}
        onOpenChange={setModeChangeDialogVisible}
        onConfirm={handleConfirmModeChange}
        onCancel={handleCancelModeChange}
      />
    </>
  )
}
