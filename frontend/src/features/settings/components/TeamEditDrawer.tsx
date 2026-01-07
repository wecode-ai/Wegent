// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useForm } from 'react-hook-form'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { teamApis } from '@/apis/team'
import { useTranslation } from 'react-i18next'
import { Info, Loader2 } from 'lucide-react'
import { Bot, Team, TeamBot } from '@/types/api'
import BotEdit, { AgentType } from './BotEdit'

interface TeamEditDrawerProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  editingBotId: number | null
  setEditingBotId: React.Dispatch<React.SetStateAction<number | null>>
  visible: boolean
  setVisible: React.Dispatch<React.SetStateAction<boolean>>
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  mode: 'edit' | 'prompt'
  editingTeam: Team | null
  onTeamUpdate: (updatedTeam: Team) => void
  cloningBot: Bot | null
  setCloningBot: React.Dispatch<React.SetStateAction<Bot | null>>
  // Added property to handle new team cases
  selectedBotKeys?: React.Key[]
  leaderBotId?: number | null
  unsavedPrompts?: Record<string, string>
  setUnsavedPrompts?: React.Dispatch<React.SetStateAction<Record<string, string>>>
  /** List of allowed agent types for filtering when creating/editing bots */
  allowedAgents?: AgentType[]
  /** Scope for filtering shells */
  scope?: 'personal' | 'group' | 'all'
  /** Group name when scope is 'group' */
  groupName?: string
}

function PromptEdit({
  team,
  allBots,
  onClose,
  toast,
  onTeamUpdate,
  isNewTeam = false,
  selectedBotKeys = [],
  leaderBotId = null,
  unsavedPrompts = {},
  setUnsavedPrompts,
}: {
  team?: Team
  allBots: Bot[]
  onClose: () => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  onTeamUpdate: (updatedTeam: Team) => void
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  isNewTeam?: boolean
  selectedBotKeys?: React.Key[]
  leaderBotId?: number | null
  unsavedPrompts?: Record<string, string>
  setUnsavedPrompts?: React.Dispatch<React.SetStateAction<Record<string, string>>>
}) {
  const { t } = useTranslation()
  const [loading, setLoading] = React.useState(false)

  const drawerTitle = React.useMemo(() => {
    if (isNewTeam) return t('common:team.prompts_drawer_title_new')
    if (team) return t('common:team.prompts_drawer_title_existing', { name: team.name })
    return t('common:team.prompts_drawer_title_generic')
  }, [isNewTeam, team, t])

  const handleBack = React.useCallback(() => {
    onClose()
  }, [onClose])

  const teamBotsWithDetails = React.useMemo(() => {
    if (isNewTeam) {
      // Handle new team case
      const allBotIds = [...(selectedBotKeys || [])]
      if (leaderBotId !== null && !allBotIds.includes(String(leaderBotId))) {
        allBotIds.unshift(String(leaderBotId))
      }

      return allBotIds.map(botId => {
        const botDetails = allBots.find(b => String(b.id) === String(botId))
        const numericBotId = Number(botId)
        return {
          bot_id: numericBotId,
          bot_prompt: unsavedPrompts[`prompt-${numericBotId}`] || '',
          name: botDetails?.name || `Bot ID: ${botId}`,
          isLeader: numericBotId === leaderBotId,
          basePrompt: botDetails?.system_prompt || '',
        }
      })
    } else if (!team) {
      return []
    } else {
      // Handle existing team case, including unsaved new Bot
      const selectedIds = Array.isArray(selectedBotKeys)
        ? (selectedBotKeys as React.Key[]).map(key => Number(key)).filter(id => !Number.isNaN(id))
        : []

      const orderedIds: number[] = []
      if (leaderBotId !== null) {
        orderedIds.push(leaderBotId)
      }
      selectedIds.forEach(id => {
        if (!orderedIds.includes(id)) {
          orderedIds.push(id)
        }
      })
      team.bots.forEach(teamBot => {
        if (!orderedIds.includes(teamBot.bot_id)) {
          orderedIds.push(teamBot.bot_id)
        }
      })

      return orderedIds.map(botId => {
        const teamBot = team.bots.find(b => b.bot_id === botId)
        const botDetails = allBots.find(b => b.id === botId)
        const promptKey = `prompt-${botId}`
        const promptValue = unsavedPrompts?.[promptKey] ?? teamBot?.bot_prompt ?? ''

        return {
          bot_id: botId,
          bot_prompt: promptValue,
          name: botDetails?.name || (teamBot ? `Bot ID: ${teamBot.bot_id}` : `Bot ID: ${botId}`),
          isLeader: teamBot?.role === 'leader' || botId === leaderBotId,
          basePrompt: botDetails?.system_prompt || '',
          role: teamBot?.role,
        }
      })
    }
  }, [team, allBots, isNewTeam, selectedBotKeys, leaderBotId, unsavedPrompts])

  // Initialize form with default values
  const defaultValues = React.useMemo(() => {
    const values: Record<string, string> = {}
    teamBotsWithDetails.forEach(bot => {
      values[`prompt-${bot.bot_id}`] = bot.bot_prompt
    })
    return values
  }, [teamBotsWithDetails])

  const form = useForm({
    defaultValues,
  })

  // Update form when teamBotsWithDetails changes
  React.useEffect(() => {
    const values: Record<string, string> = {}
    teamBotsWithDetails.forEach(bot => {
      values[`prompt-${bot.bot_id}`] = bot.bot_prompt
    })
    form.reset(values)
  }, [teamBotsWithDetails, form])

  React.useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return

      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement &&
        (activeElement.getAttribute('role') === 'combobox' ||
          activeElement.closest('common:.ant-select-dropdown'))
      ) {
        return
      }

      handleBack()
    }

    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [handleBack])

  const handleSave = async () => {
    try {
      setLoading(true)
      const values = form.getValues()
      const existingBotIds = team ? team.bots.map(bot => bot.bot_id) : []
      const currentBotIds = teamBotsWithDetails.map(bot => bot.bot_id)
      const structureChanged =
        currentBotIds.length !== existingBotIds.length ||
        currentBotIds.some(id => !existingBotIds.includes(id)) ||
        existingBotIds.some(id => !currentBotIds.includes(id))
      const existingLeaderId = team?.bots.find(b => b.role === 'leader')?.bot_id ?? null
      const leaderChanged = (leaderBotId ?? null) !== (existingLeaderId ?? null)
      const shouldPersistLocally = isNewTeam || structureChanged || leaderChanged

      const collectPrompts = () => {
        const newPrompts: Record<string, string> = {}
        teamBotsWithDetails.forEach(bot => {
          const key = `prompt-${bot.bot_id}`
          const value = (values[key] ?? '').trim()
          newPrompts[key] = value
        })
        return newPrompts
      }

      if (shouldPersistLocally) {
        if (setUnsavedPrompts) {
          setUnsavedPrompts(collectPrompts())
        }
        toast({
          title: t('common:team.prompts_save_success'),
        })
        onClose()
        return
      }

      if (team) {
        // Handle existing team case
        const updatedBots: TeamBot[] = team.bots.map(teamBot => ({
          ...teamBot,
          bot_prompt: values[`prompt-${teamBot.bot_id}`] || '',
        }))

        await teamApis.updateTeam(team.id, {
          name: team.name,
          workflow: team.workflow,
          bots: updatedBots,
        })

        // Update team state
        onTeamUpdate({ ...team, bots: updatedBots })

        toast({
          title: t('common:team.prompts_update_success'),
        })
        onClose()
      }
    } catch {
      toast({
        variant: 'destructive',
        title: t('common:team.prompts_update_error'),
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handleBack}
          className="flex items-center text-muted-foreground hover:text-foreground text-base"
          title={t('common:common.back')}
        >
          <svg
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="mr-1"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common:common.back')}
        </button>
        <Button onClick={handleSave} disabled={loading}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('common:actions.save')}
        </Button>
      </div>

      <h2 className="text-lg font-semibold mb-3">{drawerTitle}</h2>
      <Alert className="mb-4">
        <Info className="h-4 w-4" />
        <AlertDescription>
          <div className="font-medium">{t('common:team.prompts_scope_hint')}</div>
          <div className="text-sm text-muted-foreground mt-1">
            {t('common:team.prompts_scope_sub')}
          </div>
        </AlertDescription>
      </Alert>

      <div className="flex-grow overflow-y-auto custom-scrollbar pr-4 space-y-4">
        {teamBotsWithDetails.map(bot => (
          <div key={bot.bot_id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="font-medium text-sm">
                {bot.name}
                {bot.isLeader && (
                  <span className="text-muted-foreground ml-2 font-semibold">(Leader)</span>
                )}
              </label>
              {bot.basePrompt && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="link" size="sm" className="h-auto p-0 text-xs">
                      {t('common:team.prompts_base_button')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="whitespace-pre-wrap text-xs leading-5">{bot.basePrompt}</div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <Textarea
              rows={4}
              placeholder={t('common:team.prompts_placeholder')}
              className="bg-base border-border"
              {...form.register(`prompt-${bot.bot_id}`)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function TeamEditDrawer(props: TeamEditDrawerProps) {
  const {
    bots,
    setBots,
    editingBotId,
    setEditingBotId,
    visible,
    setVisible,
    toast,
    mode,
    editingTeam,
    onTeamUpdate,
    cloningBot,
    setCloningBot,
  } = props

  const handleClose = () => {
    setVisible(false)
    setEditingBotId(null)
    setCloningBot(null)
  }

  // Ensure scope and groupName have default values
  const scope = props.scope || 'personal'
  const groupName = props.groupName

  return (
    <Drawer open={visible} onOpenChange={open => !open && handleClose()}>
      <DrawerContent className="h-[100vh] max-w-[860px] ml-auto" data-team-edit-drawer="true">
        <DrawerTitle className="sr-only">
          {mode === 'edit' ? 'Edit Bot' : 'Edit Prompts'}
        </DrawerTitle>
        <div className="h-full overflow-y-auto">
          {mode === 'edit' && editingBotId !== null && (
            <BotEdit
              bots={bots}
              setBots={setBots}
              editingBotId={editingBotId}
              cloningBot={cloningBot}
              onClose={() => {
                setEditingBotId(null)
                setCloningBot(null)
                setVisible(false)
              }}
              toast={toast}
              allowedAgents={props.allowedAgents}
              scope={scope}
              groupName={groupName}
            />
          )}
          {mode === 'prompt' && (
            <PromptEdit
              team={editingTeam || undefined}
              allBots={bots}
              onClose={handleClose}
              toast={toast}
              onTeamUpdate={onTeamUpdate}
              setBots={setBots}
              isNewTeam={!editingTeam}
              selectedBotKeys={props.selectedBotKeys}
              leaderBotId={props.leaderBotId}
              unsavedPrompts={props.unsavedPrompts}
              setUnsavedPrompts={props.setUnsavedPrompts}
            />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
