// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2 } from 'lucide-react'

import { Bot, Team } from '@/types/api'
import {
  TeamMode,
  getFilteredBotsForMode,
  AgentType,
  getActualShellType,
} from '@/features/settings/components/team-modes'
import TeamEditDrawer from '@/features/settings/components/TeamEditDrawer'
import { useTranslation } from '@/hooks/useTranslation'
import { UnifiedShell } from '@/apis/shells'
import { BotEditRef } from '@/features/settings/components/BotEdit'
import {
  adminApis,
  AdminPublicTeam,
  AdminPublicTeamCreate,
  AdminPublicTeamUpdate,
} from '@/apis/admin'
import { publicResourceApis } from '@/apis/publicResources'

// Import sub-components from settings
import TeamBasicInfoForm from '@/features/settings/components/team-edit/TeamBasicInfoForm'
import TeamModeSelector from '@/features/settings/components/team-edit/TeamModeSelector'
import TeamModeEditor from '@/features/settings/components/team-edit/TeamModeEditor'
import TeamModeChangeDialog from '@/features/settings/components/team-edit/TeamModeChangeDialog'

interface PublicTeamEditDialogProps {
  open: boolean
  onClose: () => void
  editingTeam: AdminPublicTeam | null
  onSuccess: () => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
}

/**
 * Convert basic form data to Team CRD JSON structure
 */
function buildTeamJson(data: {
  name: string
  description: string
  bindMode: ('chat' | 'code' | 'knowledge' | 'task')[]
  icon: string | null
  requiresWorkspace: boolean | null
  mode: TeamMode
  members: { botName: string; botPrompt: string; role?: string; requireConfirmation?: boolean }[]
}): Record<string, unknown> {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Team',
    metadata: {
      name: data.name,
      namespace: 'default',
    },
    spec: {
      collaborationModel: data.mode,
      bindMode: data.bindMode,
      description: data.description || undefined,
      icon: data.icon || undefined,
      requiresWorkspace: data.requiresWorkspace ?? true,
      members: data.members.map(m => ({
        botRef: {
          name: m.botName,
          namespace: 'default',
        },
        botPrompt: m.botPrompt || undefined,
        role: m.role || undefined,
        requireConfirmation: m.requireConfirmation || undefined,
      })),
    },
  }
}

/**
 * Extract bot name from botRef (can be object or string for backward compatibility)
 */
function extractBotName(botRef: unknown): string {
  if (typeof botRef === 'object' && botRef !== null) {
    return ((botRef as Record<string, unknown>).name as string) || ''
  }
  if (typeof botRef === 'string') {
    return botRef
  }
  return ''
}

/**
 * Parse Team CRD JSON to basic form data
 */
function parseTeamJson(json: Record<string, unknown>): {
  name: string
  description: string
  bindMode: ('chat' | 'code' | 'knowledge')[]
  icon: string | null
  requiresWorkspace: boolean | null
  mode: TeamMode
  members: { botName: string; botPrompt: string; role?: string; requireConfirmation?: boolean }[]
} | null {
  try {
    const metadata = (json?.metadata as Record<string, unknown>) || {}
    const spec = (json?.spec as Record<string, unknown>) || {}

    const name = (metadata?.name as string) || ''
    const description = (spec?.description as string) || ''
    const bindMode = (spec?.bindMode as ('chat' | 'code' | 'knowledge')[]) || ['chat', 'code']
    const icon = (spec?.icon as string) || null
    const requiresWorkspace = (spec?.requiresWorkspace as boolean) ?? true
    const mode = (spec?.collaborationModel as TeamMode) || 'solo'

    const rawMembers = (spec?.members as Array<Record<string, unknown>>) || []
    const members = rawMembers.map(m => ({
      botName: extractBotName(m?.botRef),
      botPrompt: (m?.botPrompt as string) || '',
      role: (m?.role as string) || undefined,
      requireConfirmation: (m?.requireConfirmation as boolean) || undefined,
    }))

    return { name, description, bindMode, icon, requiresWorkspace, mode, members }
  } catch {
    return null
  }
}

export default function PublicTeamEditDialog({
  open,
  onClose,
  editingTeam,
  onSuccess,
  toast,
}: PublicTeamEditDialogProps) {
  const { t } = useTranslation('admin')

  // Tab state
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic')

  // Status toggle
  const [isActive, setIsActive] = useState(true)

  // Basic mode form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<TeamMode>('solo')
  const [bindMode, setBindMode] = useState<('chat' | 'code' | 'knowledge' | 'task')[]>(['chat'])
  const [icon, setIcon] = useState<string | null>(null)
  const [requiresWorkspace, setRequiresWorkspace] = useState<boolean | null>(true)

  // Bot selection state
  const [selectedBotKeys, setSelectedBotKeys] = useState<React.Key[]>([])
  const [leaderBotId, setLeaderBotId] = useState<number | null>(null)

  // Advanced mode form state (JSON editor)
  const [jsonConfig, setJsonConfig] = useState('{}')
  const [jsonError, setJsonError] = useState('')
  const [namespace, setNamespace] = useState('default')

  // Shared state
  const [saving, setSaving] = useState(false)
  const [bots, setBots] = useState<Bot[]>([])
  const [shells, setShells] = useState<UnifiedShell[]>([])
  const [loadingBots, setLoadingBots] = useState(false)

  // Bot editing related state
  const [editingBotDrawerVisible, setEditingBotDrawerVisible] = useState(false)
  const [editingBotId, setEditingBotId] = useState<number | null>(null)
  const [drawerMode, setDrawerMode] = useState<'edit' | 'prompt'>('edit')
  const [cloningBot, setCloningBot] = useState<Bot | null>(null)

  // Store unsaved team prompts
  const [unsavedPrompts, setUnsavedPrompts] = useState<Record<string, string>>({})

  // Store requireConfirmation settings for pipeline mode
  const [requireConfirmationMap, setRequireConfirmationMap] = useState<Record<number, boolean>>({})

  // Mode change confirmation dialog state
  const [modeChangeDialogVisible, setModeChangeDialogVisible] = useState(false)
  const [pendingMode, setPendingMode] = useState<TeamMode | null>(null)
  const [shouldCollapseSelector, setShouldCollapseSelector] = useState(false)

  // Ref for BotEdit in solo mode
  const botEditRef = useRef<BotEditRef | null>(null)

  const isEditing = editingTeam !== null

  // Load public bots and shells on mount
  useEffect(() => {
    if (!open) return

    const fetchResources = async () => {
      setLoadingBots(true)
      try {
        const [botsData, shellsData] = await Promise.all([
          publicResourceApis.getPublicBots(),
          publicResourceApis.getPublicShells(),
        ])
        setBots(botsData)
        setShells(shellsData)
      } catch (error) {
        console.error('Failed to fetch public resources:', error)
        toast({
          variant: 'destructive',
          title: t('public_teams.errors.load_failed'),
        })
      } finally {
        setLoadingBots(false)
      }
    }

    fetchResources()
  }, [open, toast, t])

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return

    if (editingTeam) {
      // Editing mode - populate form from existing team
      setIsActive(editingTeam.is_active)
      setNamespace(editingTeam.namespace)
      setJsonConfig(JSON.stringify(editingTeam.json, null, 2))

      // Try to parse JSON to populate basic form
      const parsed = parseTeamJson(editingTeam.json)
      if (parsed) {
        setName(parsed.name)
        setDescription(parsed.description)
        setBindMode(parsed.bindMode)
        setIcon(parsed.icon)
        setRequiresWorkspace(parsed.requiresWorkspace)
        setMode(parsed.mode)

        // Map member bot names to bot IDs
        const memberBotNames = parsed.members.map(m => m.botName)
        const leaderMember = parsed.members.find(m => m.role === 'leader')

        // Find bot IDs from loaded bots
        const botIds = memberBotNames
          .map(botName => bots.find(b => b.name === botName)?.id)
          .filter((id): id is number => id !== undefined)
          .map(id => String(id))
        setSelectedBotKeys(botIds)

        if (leaderMember) {
          const leaderBot = bots.find(b => b.name === leaderMember.botName)
          setLeaderBotId(leaderBot?.id ?? null)
        }

        // Initialize requireConfirmationMap
        const confirmMap: Record<number, boolean> = {}
        parsed.members.forEach(m => {
          if (m.requireConfirmation) {
            const bot = bots.find(b => b.name === m.botName)
            if (bot) {
              confirmMap[bot.id] = true
            }
          }
        })
        setRequireConfirmationMap(confirmMap)

        // Initialize unsaved prompts
        const promptMap: Record<string, string> = {}
        parsed.members.forEach(m => {
          const bot = bots.find(b => b.name === m.botName)
          if (bot && m.botPrompt) {
            promptMap[`prompt-${bot.id}`] = m.botPrompt
          }
        })
        setUnsavedPrompts(promptMap)
      }
    } else {
      // Create mode - reset to defaults
      setIsActive(true)
      setName('')
      setDescription('')
      setBindMode(['chat'])
      setIcon(null)
      setRequiresWorkspace(true)
      setMode('solo')
      setSelectedBotKeys([])
      setLeaderBotId(null)
      setJsonConfig('{}')
      setJsonError('')
      setNamespace('default')
      setUnsavedPrompts({})
      setRequireConfirmationMap({})
    }
    setActiveTab('basic')
  }, [open, editingTeam, bots])

  // Filter bots based on current mode
  const filteredBots = useMemo(() => {
    return getFilteredBotsForMode(bots, mode, shells)
  }, [bots, mode, shells])

  // Get allowed agents for current mode
  const allowedAgentsForMode = useMemo((): AgentType[] | undefined => {
    const MODE_AGENT_FILTER: Record<TeamMode, AgentType[] | null> = {
      solo: null,
      pipeline: ['ClaudeCode', 'Agno'],
      route: ['Agno'],
      coordinate: ['Agno', 'ClaudeCode'],
      collaborate: ['Agno'],
    }
    const allowed = MODE_AGENT_FILTER[mode]
    return allowed === null ? undefined : allowed
  }, [mode])

  const teamPromptMap = useMemo(() => {
    const map = new Map<number, boolean>()
    Object.entries(unsavedPrompts).forEach(([key, value]) => {
      const id = Number(key.replace('prompt-', ''))
      if (!Number.isNaN(id)) {
        map.set(id, !!value?.trim())
      }
    })
    return map
  }, [unsavedPrompts])

  // Build shell map for looking up actual shell types
  const shellMap = useMemo(() => {
    const map = new Map<string, UnifiedShell>()
    shells.forEach(shell => map.set(shell.name, shell))
    return map
  }, [shells])

  // Check if mode change needs confirmation
  const needsModeChangeConfirmation = useCallback(() => {
    const hasSelectedBots = selectedBotKeys.length > 0 || leaderBotId !== null
    const hasUnsavedPrompts = Object.values(unsavedPrompts).some(
      value => (value ?? '').trim().length > 0
    )
    return hasSelectedBots || hasUnsavedPrompts
  }, [selectedBotKeys, leaderBotId, unsavedPrompts])

  // Execute mode change with reset
  const executeModeChange = useCallback((newMode: TeamMode) => {
    setMode(newMode)
    setSelectedBotKeys([])
    setLeaderBotId(null)
    setUnsavedPrompts({})
    setRequireConfirmationMap({})
  }, [])

  // Change Mode with confirmation
  const handleModeChange = (newMode: TeamMode) => {
    if (newMode === mode) return

    if (needsModeChangeConfirmation()) {
      setPendingMode(newMode)
      setModeChangeDialogVisible(true)
    } else {
      executeModeChange(newMode)
      setShouldCollapseSelector(true)
    }
  }

  const handleConfirmModeChange = () => {
    if (pendingMode) {
      executeModeChange(pendingMode)
    }
    setModeChangeDialogVisible(false)
    setPendingMode(null)
    setShouldCollapseSelector(true)
  }

  const handleCollapseHandled = useCallback(() => {
    setShouldCollapseSelector(false)
  }, [])

  const handleCancelModeChange = () => {
    setModeChangeDialogVisible(false)
    setPendingMode(null)
  }

  const isDifyLeader = useMemo(() => {
    if (leaderBotId === null) return false
    const leader = filteredBots.find((b: Bot) => b.id === leaderBotId)
    return leader?.shell_type === 'Dify'
  }, [leaderBotId, filteredBots])

  // Leader change handler
  const onLeaderChange = (botId: number) => {
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId))
    }

    const newLeader = filteredBots.find((b: Bot) => b.id === botId)

    if (newLeader?.shell_type === 'Dify') {
      setSelectedBotKeys([])
      setLeaderBotId(botId)
      return
    }

    const newLeaderShellType = getActualShellType(newLeader?.shell_type || '', shellMap)

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

  // Validate JSON config for advanced mode
  const validateJsonConfig = (value: string): Record<string, unknown> | null => {
    if (!value.trim()) {
      setJsonError(t('public_teams.errors.config_required'))
      return null
    }
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError(t('public_teams.errors.config_invalid_json'))
        return null
      }
      setJsonError('')
      return parsed as Record<string, unknown>
    } catch {
      setJsonError(t('public_teams.errors.config_invalid_json'))
      return null
    }
  }

  // Sync basic form to JSON when switching to advanced tab
  const syncBasicToAdvanced = useCallback(() => {
    // Build members array from selected bots
    const members = []
    if (leaderBotId !== null) {
      const leaderBot = bots.find(b => b.id === leaderBotId)
      if (leaderBot) {
        members.push({
          botName: leaderBot.name,
          botPrompt: unsavedPrompts[`prompt-${leaderBotId}`] || '',
          role: 'leader',
          requireConfirmation: requireConfirmationMap[leaderBotId] || undefined,
        })
      }
    }

    selectedBotKeys.forEach(key => {
      const botId = Number(key)
      if (botId === leaderBotId) return // Skip leader, already added
      const bot = bots.find(b => b.id === botId)
      if (bot) {
        members.push({
          botName: bot.name,
          botPrompt: unsavedPrompts[`prompt-${botId}`] || '',
          requireConfirmation: requireConfirmationMap[botId] || undefined,
        })
      }
    })

    const json = buildTeamJson({
      name,
      description,
      bindMode,
      icon,
      requiresWorkspace,
      mode,
      members,
    })

    setJsonConfig(JSON.stringify(json, null, 2))
    setJsonError('')
  }, [
    name,
    description,
    bindMode,
    icon,
    requiresWorkspace,
    mode,
    leaderBotId,
    selectedBotKeys,
    unsavedPrompts,
    requireConfirmationMap,
    bots,
  ])

  // Sync JSON to basic form when switching to basic tab
  const syncAdvancedToBasic = useCallback(() => {
    const parsed = parseTeamJson(JSON.parse(jsonConfig))
    if (!parsed) {
      toast({
        variant: 'destructive',
        title: t('public_teams.errors.config_invalid_json'),
      })
      return false
    }

    setName(parsed.name)
    setDescription(parsed.description)
    setBindMode(parsed.bindMode)
    setIcon(parsed.icon)
    setRequiresWorkspace(parsed.requiresWorkspace)
    setMode(parsed.mode)

    // Map member bot names to bot IDs
    const botIds = parsed.members
      .map(m => bots.find(b => b.name === m.botName)?.id)
      .filter((id): id is number => id !== undefined)
      .map(id => String(id))
    setSelectedBotKeys(botIds)

    const leaderMember = parsed.members.find(m => m.role === 'leader')
    if (leaderMember) {
      const leaderBot = bots.find(b => b.name === leaderMember.botName)
      setLeaderBotId(leaderBot?.id ?? null)
    } else {
      setLeaderBotId(null)
    }

    // Update prompts and confirmation map
    const promptMap: Record<string, string> = {}
    const confirmMap: Record<number, boolean> = {}
    parsed.members.forEach(m => {
      const bot = bots.find(b => b.name === m.botName)
      if (bot) {
        if (m.botPrompt) {
          promptMap[`prompt-${bot.id}`] = m.botPrompt
        }
        if (m.requireConfirmation) {
          confirmMap[bot.id] = true
        }
      }
    })
    setUnsavedPrompts(promptMap)
    setRequireConfirmationMap(confirmMap)

    return true
  }, [jsonConfig, bots, toast, t])

  // Handle tab change with sync
  const handleTabChange = (newTab: string) => {
    if (newTab === 'advanced' && activeTab === 'basic') {
      syncBasicToAdvanced()
    } else if (newTab === 'basic' && activeTab === 'advanced') {
      try {
        if (!syncAdvancedToBasic()) {
          return // Don't switch if sync failed
        }
      } catch {
        toast({
          variant: 'destructive',
          title: t('public_teams.errors.config_invalid_json'),
        })
        return
      }
    }
    setActiveTab(newTab as 'basic' | 'advanced')
  }

  // Save handler
  const handleSave = async () => {
    setSaving(true)

    try {
      let teamJson: Record<string, unknown>

      if (activeTab === 'basic') {
        // Validate basic form
        if (!name.trim()) {
          toast({
            variant: 'destructive',
            title: t('public_teams.errors.name_required'),
          })
          setSaving(false)
          return
        }

        if (bindMode.length === 0) {
          toast({
            variant: 'destructive',
            title: t('common:team.bind_mode_required'),
          })
          setSaving(false)
          return
        }

        // For solo mode with BotEdit ref, save bot first
        if (mode === 'solo' && botEditRef.current) {
          const validation = botEditRef.current.validateBot()
          if (!validation.isValid) {
            toast({
              variant: 'destructive',
              title: validation.error || t('common:bot.errors.required'),
            })
            setSaving(false)
            return
          }

          const savedBotId = await botEditRef.current.saveBot()
          if (savedBotId === null) {
            setSaving(false)
            return
          }

          // Refresh bots list to get the new bot
          const updatedBots = await publicResourceApis.getPublicBots()
          setBots(updatedBots)

          const savedBot = updatedBots.find(b => b.id === savedBotId)
          if (!savedBot) {
            toast({
              variant: 'destructive',
              title: t('public_teams.errors.create_failed'),
            })
            setSaving(false)
            return
          }

          teamJson = buildTeamJson({
            name,
            description,
            bindMode,
            icon,
            requiresWorkspace,
            mode,
            members: [
              {
                botName: savedBot.name,
                botPrompt: unsavedPrompts[`prompt-${savedBotId}`] || '',
                role: 'leader',
              },
            ],
          })
        } else {
          // Non-solo mode - require leaderBotId
          if (leaderBotId == null) {
            toast({
              variant: 'destructive',
              title:
                mode === 'solo' ? t('common:team.bot_required') : t('common:team.leader_required'),
            })
            setSaving(false)
            return
          }

          // Build members array
          const members = []
          const leaderBot = bots.find(b => b.id === leaderBotId)
          if (leaderBot) {
            members.push({
              botName: leaderBot.name,
              botPrompt: unsavedPrompts[`prompt-${leaderBotId}`] || '',
              role: 'leader',
              requireConfirmation: requireConfirmationMap[leaderBotId] || undefined,
            })
          }

          if (!isDifyLeader) {
            selectedBotKeys.forEach(key => {
              const botId = Number(key)
              if (botId === leaderBotId) return
              const bot = bots.find(b => b.id === botId)
              if (bot) {
                members.push({
                  botName: bot.name,
                  botPrompt: unsavedPrompts[`prompt-${botId}`] || '',
                  requireConfirmation: requireConfirmationMap[botId] || undefined,
                })
              }
            })
          }

          teamJson = buildTeamJson({
            name,
            description,
            bindMode,
            icon,
            requiresWorkspace,
            mode,
            members,
          })
        }
      } else {
        // Advanced mode - use JSON directly
        const parsed = validateJsonConfig(jsonConfig)
        if (!parsed) {
          setSaving(false)
          return
        }
        teamJson = parsed
      }

      // Create or update team
      if (editingTeam) {
        const updateData: AdminPublicTeamUpdate = {
          json: teamJson,
          is_active: isActive,
        }
        if (namespace !== editingTeam.namespace) {
          updateData.namespace = namespace
        }
        await adminApis.updatePublicTeam(editingTeam.id, updateData)
        toast({ title: t('public_teams.success.updated') })
      } else {
        const createData: AdminPublicTeamCreate = {
          name:
            name.trim() ||
            (teamJson.metadata as Record<string, unknown>)?.name?.toString() ||
            'new-team',
          namespace,
          json: teamJson,
        }
        await adminApis.createPublicTeam(createData)
        toast({ title: t('public_teams.success.created') })
      }

      onSuccess()
      onClose()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditing
          ? t('public_teams.errors.update_failed')
          : t('public_teams.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  // Create a fake Team object for TeamEditDrawer compatibility
  const fakeEditingTeam = useMemo((): Team | null => {
    if (!editingTeam) return null
    return {
      id: editingTeam.id,
      name: editingTeam.name,
      namespace: editingTeam.namespace,
      description: editingTeam.description || '',
      bots: [],
      workflow: { mode },
      is_active: editingTeam.is_active,
      user_id: 0,
      created_at: editingTeam.created_at,
      updated_at: editingTeam.updated_at,
      bind_mode: bindMode,
      icon: icon || undefined,
      requires_workspace: requiresWorkspace ?? true,
    }
  }, [editingTeam, mode, bindMode, icon, requiresWorkspace])

  const leaderOptions = useMemo(() => filteredBots, [filteredBots])

  return (
    <>
      <Dialog open={open} onOpenChange={o => !o && onClose()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle>
                {isEditing ? t('public_teams.edit_team') : t('public_teams.create_team')}
              </DialogTitle>
              {isEditing && (
                <div className="flex items-center gap-2 mr-8">
                  <Label htmlFor="status-toggle" className="text-sm text-text-muted">
                    {isActive ? t('public_teams.status.active') : t('public_teams.status.inactive')}
                  </Label>
                  <Switch id="status-toggle" checked={isActive} onCheckedChange={setIsActive} />
                </div>
              )}
            </div>
          </DialogHeader>

          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="flex-1 flex flex-col overflow-hidden"
          >
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="basic">{t('public_teams.tabs.basic')}</TabsTrigger>
              <TabsTrigger value="advanced">{t('public_teams.tabs.advanced')}</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="flex-1 overflow-y-auto space-y-6 py-2 mt-0">
              {loadingBots ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
                </div>
              ) : (
                <>
                  {/* Basic Info Section */}
                  <TeamBasicInfoForm
                    name={name}
                    setName={setName}
                    description={description}
                    setDescription={setDescription}
                    bindMode={bindMode}
                    setBindMode={setBindMode}
                    icon={icon}
                    setIcon={setIcon}
                    requiresWorkspace={requiresWorkspace}
                    setRequiresWorkspace={setRequiresWorkspace}
                  />

                  {/* Mode Selection Section */}
                  <TeamModeSelector
                    mode={mode}
                    onModeChange={handleModeChange}
                    shouldCollapse={shouldCollapseSelector}
                    onCollapseHandled={handleCollapseHandled}
                  />

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
                    editingTeam={fakeEditingTeam}
                    editingTeamId={editingTeam?.id ?? null}
                    toast={toast}
                    unsavedPrompts={unsavedPrompts}
                    teamPromptMap={teamPromptMap}
                    isDifyLeader={isDifyLeader}
                    leaderOptions={leaderOptions}
                    allowedAgentsForMode={allowedAgentsForMode}
                    botEditRef={botEditRef}
                    scope="public"
                    requireConfirmationMap={requireConfirmationMap}
                    setRequireConfirmationMap={setRequireConfirmationMap}
                    onEditBot={handleEditBot}
                    onCreateBot={handleCreateBot}
                    onCloneBot={handleCloneBot}
                    onOpenPromptDrawer={handleOpenPromptDrawer}
                    onLeaderChange={onLeaderChange}
                  />
                </>
              )}
            </TabsContent>

            <TabsContent value="advanced" className="flex-1 overflow-y-auto space-y-4 py-2 mt-0">
              <div className="space-y-2">
                <Label htmlFor="adv-namespace">{t('public_teams.form.namespace')}</Label>
                <Input
                  id="adv-namespace"
                  value={namespace}
                  onChange={e => setNamespace(e.target.value)}
                  placeholder={t('public_teams.form.namespace_placeholder')}
                />
              </div>
              <div className="space-y-2 flex-1">
                <Label htmlFor="adv-config">{t('public_teams.form.config')} *</Label>
                <Textarea
                  id="adv-config"
                  value={jsonConfig}
                  onChange={e => {
                    setJsonConfig(e.target.value)
                    validateJsonConfig(e.target.value)
                  }}
                  placeholder={t('public_teams.form.config_placeholder')}
                  className={`font-mono text-sm min-h-[400px] ${jsonError ? 'border-error' : ''}`}
                />
                {jsonError && <p className="text-xs text-error">{jsonError}</p>}
                <p className="text-xs text-text-muted">{t('public_teams.form.config_hint')}</p>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.save')}
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
        editingTeam={fakeEditingTeam}
        onTeamUpdate={() => {
          // Refresh bots list after team update
          publicResourceApis.getPublicBots().then(setBots)
        }}
        cloningBot={cloningBot}
        setCloningBot={setCloningBot}
        selectedBotKeys={selectedBotKeys}
        leaderBotId={leaderBotId}
        unsavedPrompts={unsavedPrompts}
        setUnsavedPrompts={setUnsavedPrompts}
        allowedAgents={allowedAgentsForMode}
        scope="public"
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
