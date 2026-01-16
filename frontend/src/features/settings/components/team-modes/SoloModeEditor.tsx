// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { RiRobot2Line, RiMagicLine } from 'react-icons/ri'
import { Plus, ChevronDown, Check } from 'lucide-react'
import { Bot, Team } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { getPromptBadgeStyle, type PromptBadgeVariant } from '@/utils/styles'
import { Tag } from '@/components/ui/tag'
import BotEdit, { AgentType, BotEditRef } from '../BotEdit'

export interface SoloModeEditorProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  selectedBotId: number | null
  setSelectedBotId: React.Dispatch<React.SetStateAction<number | null>>
  editingTeam: Team | null
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  unsavedPrompts?: Record<string, string>
  teamPromptMap?: Map<number, boolean>
  onOpenPromptDrawer?: () => void
  /** Callback to create a new bot (reuse TeamEdit's handler) - deprecated, now handled inline */
  onCreateBot?: () => void
  /** List of allowed agent types for filtering when creating bots */
  allowedAgents?: AgentType[]
  /** Current team editing ID (0 = new team) */
  editingTeamId?: number
  /** Ref to access BotEdit methods for external saving */
  botEditRef?: React.RefObject<BotEditRef | null>
  /** Scope for filtering shells */
  scope?: 'personal' | 'group' | 'all'
  /** Group name when scope is 'group' */
  groupName?: string
}

export default function SoloModeEditor({
  bots,
  setBots,
  selectedBotId,
  setSelectedBotId,
  toast,
  unsavedPrompts = {},
  teamPromptMap,
  onOpenPromptDrawer,
  allowedAgents,
  editingTeamId,
  botEditRef,
  scope,
  groupName,
}: SoloModeEditorProps) {
  const { t } = useTranslation()

  // Calculate prompt summary (similar to BotTransfer)
  const promptSummary = React.useMemo<{ label: string; variant: PromptBadgeVariant }>(() => {
    if (selectedBotId === null) {
      return {
        label: t('common:team.prompts_tag_none'),
        variant: 'none',
      }
    }

    // Check unsaved prompts first
    const unsavedPrompt = unsavedPrompts[`prompt-${selectedBotId}`]
    const hasUnsavedContent = unsavedPrompt && unsavedPrompt.trim().length > 0

    // Check teamPromptMap
    const hasConfigured = teamPromptMap ? teamPromptMap.get(selectedBotId) || false : false

    if (hasUnsavedContent) {
      const countText = hasConfigured
        ? ` - ${t('common:team.prompts_tag_configured', { count: 1 })}`
        : ''
      return {
        label: `${t('common:team.prompts_tag_pending')}${countText}`,
        variant: 'pending',
      }
    }

    if (hasConfigured) {
      return {
        label: t('common:team.prompts_tag_configured', { count: 1 }),
        variant: 'configured',
      }
    }

    return {
      label: t('common:team.prompts_tag_none'),
      variant: 'none',
    }
  }, [selectedBotId, unsavedPrompts, teamPromptMap, t])

  const promptSummaryStyle = React.useMemo(
    () => getPromptBadgeStyle(promptSummary.variant),
    [promptSummary.variant]
  )

  // Determine if this is a new team without a selected bot
  const isNewTeamWithoutBot = editingTeamId === 0 && selectedBotId === null

  // State for inline bot creation mode - auto-enter for new teams
  const [isCreatingBot, setIsCreatingBot] = useState(isNewTeamWithoutBot)
  // Track bots IDs to detect new bot creation
  const prevBotIdsRef = useRef<Set<number>>(new Set(bots.map(b => b.id)))

  // Update isCreatingBot when editingTeamId or selectedBotId changes
  useEffect(() => {
    if (editingTeamId === 0 && selectedBotId === null) {
      setIsCreatingBot(true)
    }
  }, [editingTeamId, selectedBotId])

  // Get the selected bot
  const selectedBot = useMemo(() => {
    if (selectedBotId === null) return null
    return bots.find(b => b.id === selectedBotId) || null
  }, [bots, selectedBotId])

  // Handle bot selection change
  const handleBotChange = useCallback(
    (botId: number) => {
      setSelectedBotId(botId)
      setIsCreatingBot(false)
    },
    [setSelectedBotId]
  )

  // Handle create new bot - show inline creation form
  const handleCreateBot = useCallback(() => {
    setSelectedBotId(null)
    setIsCreatingBot(true)
  }, [setSelectedBotId])

  // Handle bot edit close
  const handleBotEditClose = useCallback(() => {
    // No-op for solo mode - bot changes are saved with team
  }, [])

  // Handle bot creation close - just close the creation mode (used for cancel)
  const handleBotCreateClose = useCallback(() => {
    // This is called when BotEdit's onClose is triggered
    // We don't set isCreatingBot to false here because the useEffect will handle it
    // when a new bot is detected. If no new bot is created (e.g., validation failed),
    // we keep the creation mode open.
  }, [])

  // Handle cancel creation explicitly
  const handleCancelCreate = useCallback(() => {
    // If there are existing bots, select the first one
    if (bots.length > 0) {
      setSelectedBotId(bots[0].id)
    }
    setIsCreatingBot(false)
  }, [bots, setSelectedBotId])

  // Effect to detect new bot creation and auto-select it
  useEffect(() => {
    // Find any new bot that wasn't in the previous set
    const currentBotIds = new Set(bots.map(b => b.id))
    const newBotIds = bots.filter(b => !prevBotIdsRef.current.has(b.id))

    // If there's a new bot, select it and close creation mode
    if (newBotIds.length > 0) {
      // Select the first new bot (should be the one we just created)
      const newBot = newBotIds[0]
      setSelectedBotId(newBot.id)
      // Close creation mode if we were creating
      if (isCreatingBot) {
        setIsCreatingBot(false)
      }
    }

    // Update the ref for next comparison
    prevBotIdsRef.current = currentBotIds
  }, [bots, isCreatingBot, setSelectedBotId])

  // Determine the current mode label
  const currentModeLabel = useMemo(() => {
    if (isCreatingBot) {
      return t('common:bots.new_bot')
    }
    if (selectedBot) {
      return selectedBot.name
    }
    return t('common:team.select_bot_placeholder')
  }, [isCreatingBot, selectedBot, t])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Compact header with bot switcher */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <RiRobot2Line className="w-5 h-5 text-primary" />
          <span className="text-base font-medium text-text-primary">
            {isCreatingBot ? t('common:bots.new_bot') : t('common:team.current_bot')}
          </span>
          {!isCreatingBot && selectedBot && (
            <span className="text-sm text-text-muted">({selectedBot.shell_type})</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Team prompt link - show when a bot is selected */}
          {selectedBotId !== null && onOpenPromptDrawer && !isCreatingBot && (
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-primary hover:text-primary/80"
                    onClick={onOpenPromptDrawer}
                  >
                    <RiMagicLine className="mr-1 h-4 w-4" />
                    {t('common:team.prompts_link')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('common:team.prompts_tooltip')}</p>
                </TooltipContent>
              </Tooltip>
              <Tag
                className="!m-0 !px-2 !py-0 text-xs leading-5"
                variant="default"
                style={promptSummaryStyle}
              >
                {promptSummary.label}
              </Tag>
            </div>
          )}

          {/* Bot switcher dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1">
                <span className="max-w-[120px] truncate">{currentModeLabel}</span>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* Create new bot option */}
              <DropdownMenuItem onClick={handleCreateBot} className="gap-2">
                <Plus className="h-4 w-4" />
                <span>{t('common:bots.new_bot')}</span>
                {isCreatingBot && <Check className="h-4 w-4 ml-auto" />}
              </DropdownMenuItem>

              {bots.length > 0 && <DropdownMenuSeparator />}

              {/* Existing bots list */}
              {bots.map((bot: Bot) => (
                <DropdownMenuItem
                  key={bot.id}
                  onClick={() => handleBotChange(bot.id)}
                  className="gap-2"
                >
                  <RiRobot2Line className="h-4 w-4 text-text-muted" />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="truncate">{bot.name}</span>
                    <span className="text-xs text-text-muted">{bot.shell_type}</span>
                  </div>
                  {selectedBotId === bot.id && !isCreatingBot && (
                    <Check className="h-4 w-4 ml-auto flex-shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}

              {bots.length === 0 && (
                <div className="px-2 py-1.5 text-sm text-text-muted text-center">
                  {t('common:team.no_bots_available')}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Bot details / edit area */}
      <div className="flex-1 min-h-0 overflow-hidden border border-border rounded-lg">
        {isCreatingBot ? (
          /* Show BotEdit component in creation mode */
          <div className="h-full overflow-auto">
            <BotEdit
              ref={botEditRef}
              bots={bots}
              setBots={setBots}
              editingBotId={0}
              cloningBot={null}
              onClose={handleBotCreateClose}
              toast={toast}
              embedded={true}
              readOnly={false}
              hideActions={true}
              onCancelEdit={bots.length > 0 ? handleCancelCreate : undefined}
              allowedAgents={allowedAgents}
              scope={scope}
              groupName={groupName}
            />
          </div>
        ) : selectedBotId !== null ? (
          /* Show BotEdit component in edit mode - bot saves with team */
          <div className="h-full overflow-auto">
            <BotEdit
              ref={botEditRef}
              bots={bots}
              setBots={setBots}
              editingBotId={selectedBotId}
              cloningBot={null}
              onClose={handleBotEditClose}
              toast={toast}
              embedded={true}
              readOnly={false}
              hideActions={true}
              allowedAgents={allowedAgents}
              scope={scope}
              groupName={groupName}
            />
          </div>
        ) : (
          /* No bot selected - prompt to create or select */
          <div className="flex items-center justify-center h-full text-text-muted p-4">
            <div className="text-center">
              <RiRobot2Line className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p className="mb-4">{t('common:team.no_bot_selected')}</p>
              <Button variant="outline" size="sm" onClick={handleCreateBot}>
                <Plus className="h-4 w-4 mr-1" />
                {t('common:bots.new_bot')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
