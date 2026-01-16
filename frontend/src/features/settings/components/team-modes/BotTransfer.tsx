// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useMemo } from 'react'
import { Transfer } from '@/components/ui/transfer'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tag } from '@/components/ui/tag'
import { Switch } from '@/components/ui/switch'
import { RiMagicLine } from 'react-icons/ri'
import { Edit, Plus, Copy } from 'lucide-react'
import { Bot } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { getPromptBadgeStyle, type PromptBadgeVariant } from '@/utils/styles'

export interface BotTransferProps {
  bots: Bot[]
  selectedBotKeys: React.Key[]
  setSelectedBotKeys: React.Dispatch<React.SetStateAction<React.Key[]>>
  leaderBotId?: number | null
  setLeaderBotId?: React.Dispatch<React.SetStateAction<number | null>>
  unsavedPrompts: Record<string, string>
  teamPromptMap: Map<number, boolean>
  isDifyLeader?: boolean
  selectedShellType?: string | null
  /** Whether to exclude leader from transfer list */
  excludeLeader?: boolean
  /** Whether to auto-set first selected bot as leader */
  autoSetLeader?: boolean
  /** Whether to enable drag-and-drop sorting in the right list */
  sortable?: boolean
  /** Pipeline mode: requireConfirmation settings for each bot */
  requireConfirmationMap?: Record<number, boolean>
  setRequireConfirmationMap?: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
  onEditBot: (botId: number) => void
  onCreateBot: () => void
  onCloneBot: (botId: number) => void
  onOpenPromptDrawer: () => void
}

export default function BotTransfer({
  bots,
  selectedBotKeys,
  setSelectedBotKeys,
  leaderBotId,
  setLeaderBotId,
  unsavedPrompts,
  teamPromptMap,
  isDifyLeader = false,
  selectedShellType = null,
  excludeLeader = false,
  autoSetLeader = false,
  sortable = false,
  requireConfirmationMap,
  setRequireConfirmationMap,
  onEditBot,
  onCreateBot,
  onCloneBot,
  onOpenPromptDrawer,
}: BotTransferProps) {
  const { t } = useTranslation()

  const configuredPromptBadgeStyle = useMemo(() => getPromptBadgeStyle('configured'), [])

  // Calculate prompt summary
  const promptSummary = useMemo<{ label: string; variant: PromptBadgeVariant }>(() => {
    let configuredCount = 0
    teamPromptMap.forEach(value => {
      if (value) configuredCount += 1
    })
    const unsavedHasContent = Object.values(unsavedPrompts).some(
      value => (value ?? '').trim().length > 0
    )

    if (unsavedHasContent) {
      const countText =
        configuredCount > 0
          ? ` - ${t('common:team.prompts_tag_configured', { count: configuredCount })}`
          : ''
      return {
        label: `${t('common:team.prompts_tag_pending')}${countText}`,
        variant: 'pending',
      }
    }

    if (configuredCount > 0) {
      return {
        label: t('common:team.prompts_tag_configured', { count: configuredCount }),
        variant: 'configured',
      }
    }

    return {
      label: t('common:team.prompts_tag_none'),
      variant: 'none',
    }
  }, [teamPromptMap, unsavedPrompts, t])

  const promptSummaryStyle = useMemo(
    () => getPromptBadgeStyle(promptSummary.variant),
    [promptSummary.variant]
  )

  // Data source for Transfer
  const transferData = useMemo(() => {
    let filteredBots = bots

    // Exclude leader if specified
    if (excludeLeader && leaderBotId !== null) {
      filteredBots = bots.filter(b => b.id !== leaderBotId)
    }

    return filteredBots.map(b => ({
      key: String(b.id),
      title: b.name,
      description: b.shell_type,
      disabled:
        isDifyLeader ||
        // Disable options not matching shell_type if already selected
        (selectedShellType !== null && b.shell_type !== selectedShellType),
    }))
  }, [bots, isDifyLeader, selectedShellType, excludeLeader, leaderBotId])

  // Transfer change handler
  const onTransferChange = (
    targetKeys: string[],
    direction: 'left' | 'right',
    moveKeys: string[]
  ) => {
    if (direction === 'right') {
      const newKeys = [...new Set(selectedBotKeys.concat(moveKeys))]
      setSelectedBotKeys(newKeys)
      // Auto-set first bot as leader if enabled and no leader is set
      if (autoSetLeader && setLeaderBotId && leaderBotId === null && newKeys.length > 0) {
        setLeaderBotId(Number(newKeys[0]))
      }
      return
    }
    setSelectedBotKeys(targetKeys)
    // If leader was removed and auto-set is enabled, set new leader
    if (
      autoSetLeader &&
      setLeaderBotId &&
      leaderBotId !== null &&
      !targetKeys.includes(String(leaderBotId))
    ) {
      if (targetKeys.length > 0) {
        setLeaderBotId(Number(targetKeys[0]))
      } else {
        setLeaderBotId(null)
      }
    }
  }

  // Handle order change from drag-and-drop
  const onOrderChange = (newOrder: string[]) => {
    setSelectedBotKeys(newOrder)
    // If auto-set leader is enabled, update leader to first item
    if (autoSetLeader && setLeaderBotId && newOrder.length > 0) {
      setLeaderBotId(Number(newOrder[0]))
    }
  }

  // Handle requireConfirmation toggle for pipeline mode
  const handleRequireConfirmationChange = useCallback(
    (botId: number, checked: boolean) => {
      if (setRequireConfirmationMap) {
        setRequireConfirmationMap(prev => ({
          ...prev,
          [botId]: checked,
        }))
      }
    },
    [setRequireConfirmationMap]
  )

  // Check if pipeline mode features should be shown (when requireConfirmationMap is provided)
  const showPipelineFeatures =
    requireConfirmationMap !== undefined && setRequireConfirmationMap !== undefined

  return (
    <div className="flex flex-col min-h-0 mt-1 flex-1">
      <div className="flex items-center justify-between mb-1">
        <label className="block text-lg font-semibold text-text-primary">
          {t('common:team.bots')}
        </label>
      </div>
      <div className="flex items-center gap-2 mb-2">
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

      {/* Transfer component with flex-1 to fill remaining space */}
      <div className="relative flex-1 min-h-0">
        {/* Overlay mask for Dify leader mode */}
        {isDifyLeader && (
          <div className="absolute inset-0 bg-white/50 dark:bg-black/50 z-10 flex items-center justify-center rounded-md backdrop-blur-[1px]">
            <div className="bg-background/95 px-4 py-2 rounded-md shadow-sm border border-border text-sm text-muted-foreground">
              {t('common:team.dify_no_members_hint') ||
                'Dify bots handle execution independently and do not support team members.'}
            </div>
          </div>
        )}
        <Transfer
          dataSource={transferData}
          targetKeys={selectedBotKeys.map(String)}
          onChange={onTransferChange}
          onOrderChange={onOrderChange}
          disabled={isDifyLeader}
          sortable={sortable}
          render={item => (
            <div className="flex items-center justify-between w-full">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="truncate max-w-[150px]">
                    {item.title}
                    <span className="text-xs text-text-muted">({item.description})</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{`${item.title} (${item.description})`}</p>
                </TooltipContent>
              </Tooltip>

              <div className="flex items-center">
                {teamPromptMap.get(Number(item.key)) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Tag
                        className="!m-0 !mr-2 !px-1.5 !py-0 text-[11px] leading-4"
                        variant="default"
                        style={configuredPromptBadgeStyle}
                      >
                        {t('common:team.prompts_badge')}
                      </Tag>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('common:team.prompts_badge_tooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Pipeline mode: requireConfirmation switch (only show for selected bots) */}
                {showPipelineFeatures && selectedBotKeys.includes(item.key) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center mr-2" onClick={e => e.stopPropagation()}>
                        <Switch
                          checked={requireConfirmationMap?.[Number(item.key)] ?? false}
                          onCheckedChange={checked =>
                            handleRequireConfirmationChange(Number(item.key), checked)
                          }
                          className="h-4 w-7 data-[state=checked]:bg-primary"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('common:team.require_confirmation_tooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                <Edit
                  className="ml-2 h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                  onClick={e => {
                    e.stopPropagation()
                    onEditBot(Number(item.key))
                  }}
                />
                <Copy
                  className="ml-3 h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                  onClick={e => {
                    e.stopPropagation()
                    onCloneBot(Number(item.key))
                  }}
                />
              </div>
            </div>
          )}
          titles={[t('common:team.candidates'), t('common:team.in_team')]}
          className="h-full transfer-fill"
          listStyle={{
            backgroundColor: 'rgb(var(--color-bg-surface))',
            borderColor: 'rgb(var(--color-border))',
          }}
          leftFooter={
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onCreateBot}
              disabled={isDifyLeader}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('common:bots.new_bot')}
            </Button>
          }
        />
      </div>
    </div>
  )
}
