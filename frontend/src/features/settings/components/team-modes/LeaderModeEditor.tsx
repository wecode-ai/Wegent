// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tag } from '@/components/ui/tag'
import { RiRobot2Line } from 'react-icons/ri'
import { Edit, Plus, Copy } from 'lucide-react'
import { Bot } from '@/types/api'
import { UnifiedShell } from '@/apis/shells'
import { useTranslation } from '@/hooks/useTranslation'
import { getPromptBadgeStyle } from '@/utils/styles'
import { getActualShellType } from './index'
import BotTransfer from './BotTransfer'

export interface LeaderModeEditorProps {
  bots: Bot[]
  shells: UnifiedShell[]
  selectedBotKeys: React.Key[]
  setSelectedBotKeys: React.Dispatch<React.SetStateAction<React.Key[]>>
  leaderBotId: number | null
  setLeaderBotId: React.Dispatch<React.SetStateAction<number | null>>
  unsavedPrompts: Record<string, string>
  teamPromptMap: Map<number, boolean>
  isDifyLeader: boolean
  selectedShellType: string | null
  leaderOptions: Bot[]
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  onEditBot: (botId: number) => void
  onCreateBot: () => void
  onCloneBot: (botId: number) => void
  onOpenPromptDrawer: () => void
  onLeaderChange: (botId: number) => void
}

export default function LeaderModeEditor({
  bots,
  shells,
  selectedBotKeys,
  setSelectedBotKeys,
  leaderBotId,
  setLeaderBotId,
  unsavedPrompts,
  teamPromptMap,
  isDifyLeader,
  selectedShellType,
  leaderOptions,
  onEditBot,
  onCreateBot,
  onCloneBot,
  onOpenPromptDrawer,
  onLeaderChange,
}: LeaderModeEditorProps) {
  const { t } = useTranslation()

  const configuredPromptBadgeStyle = useMemo(() => getPromptBadgeStyle('configured'), [])

  // Build shell map for looking up actual shell types
  const shellMap = useMemo(() => {
    const map = new Map<string, UnifiedShell>()
    shells.forEach(shell => map.set(shell.name, shell))
    return map
  }, [shells])

  // Filter member bots based on Leader's shell type
  // Members must have the same shell type as the Leader
  const filteredMemberBots = useMemo(() => {
    if (!leaderBotId) return bots

    const leaderBot = bots.find(bot => bot.id === leaderBotId)
    if (!leaderBot) return bots

    const leaderShellType = getActualShellType(leaderBot.shell_type, shellMap)

    // Filter bots to only include those with the same shell type as the leader
    return bots.filter(bot => {
      const botShellType = getActualShellType(bot.shell_type, shellMap)
      return botShellType === leaderShellType
    })
  }, [bots, leaderBotId, shellMap])

  return (
    <div className="rounded-md border border-border bg-base p-4 flex flex-col flex-1 min-h-0">
      {/* Leader select */}
      <div className="flex flex-col mb-4">
        <div className="flex items-center mb-1">
          <label className="block text-lg font-semibold text-text-primary">
            {t('common:team.leader')} <span className="text-red-400">*</span>
          </label>
        </div>
        <Select
          value={leaderBotId?.toString() ?? undefined}
          onValueChange={value => onLeaderChange(Number(value))}
        >
          <SelectTrigger className="w-full min-h-[36px]">
            {leaderBotId !== null ? (
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <RiRobot2Line className="w-4 h-4 text-text-muted flex-shrink-0" />
                  <span className="truncate max-w-[200px]">
                    {bots.find(b => b.id === leaderBotId)?.name || ''}
                    <span className="text-text-muted text-xs ml-1">
                      ({bots.find(b => b.id === leaderBotId)?.shell_type || ''})
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                  <Edit
                    className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                    onPointerDown={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      onEditBot(leaderBotId)
                    }}
                  />
                  <Copy
                    className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                    onPointerDown={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      onCloneBot(leaderBotId)
                    }}
                  />
                </div>
              </div>
            ) : (
              <SelectValue placeholder={t('common:team.select_leader')} />
            )}
          </SelectTrigger>
          <SelectContent>
            {leaderOptions.length === 0 ? (
              <div className="p-2 text-center">
                <Button
                  size="sm"
                  onClick={e => {
                    e.stopPropagation()
                    onCreateBot()
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {t('common:bots.new_bot')}
                </Button>
              </div>
            ) : (
              leaderOptions.map((b: Bot) => (
                <SelectItem key={b.id} value={b.id.toString()}>
                  <div className="flex items-center w-full">
                    <div className="flex min-w-0 flex-1 items-center space-x-2">
                      <RiRobot2Line className="w-4 h-4 text-text-muted flex-shrink-0" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="block truncate max-w-[200px]">
                            {b.name}{' '}
                            <span className="text-text-muted text-xs">({b.shell_type})</span>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{`${b.name} (${b.shell_type})`}</p>
                        </TooltipContent>
                      </Tooltip>
                      {teamPromptMap.get(b.id) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Tag
                              className="!m-0 !ml-1 !px-1.5 !py-0 text-[11px] leading-4"
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
                    </div>
                    <div className="flex items-center gap-3 ml-3">
                      <Edit
                        className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                        onPointerDown={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          onEditBot(b.id)
                        }}
                      />
                      <Copy
                        className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                        onPointerDown={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          onCloneBot(b.id)
                        }}
                      />
                    </div>
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Bots Transfer */}
      <BotTransfer
        bots={filteredMemberBots}
        selectedBotKeys={selectedBotKeys}
        setSelectedBotKeys={setSelectedBotKeys}
        leaderBotId={leaderBotId}
        setLeaderBotId={setLeaderBotId}
        unsavedPrompts={unsavedPrompts}
        teamPromptMap={teamPromptMap}
        isDifyLeader={isDifyLeader}
        selectedShellType={selectedShellType}
        excludeLeader={true}
        onEditBot={onEditBot}
        onCreateBot={onCreateBot}
        onCloneBot={onCloneBot}
        onOpenPromptDrawer={onOpenPromptDrawer}
      />
    </div>
  )
}
