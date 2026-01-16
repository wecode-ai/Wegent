// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Bot } from '@/types/api'
import BotTransfer from './BotTransfer'

export interface PipelineModeEditorProps {
  bots: Bot[]
  selectedBotKeys: React.Key[]
  setSelectedBotKeys: React.Dispatch<React.SetStateAction<React.Key[]>>
  leaderBotId: number | null
  setLeaderBotId: React.Dispatch<React.SetStateAction<number | null>>
  unsavedPrompts: Record<string, string>
  teamPromptMap: Map<number, boolean>
  isDifyLeader: boolean
  /** Pipeline mode: requireConfirmation settings for each bot */
  requireConfirmationMap?: Record<number, boolean>
  setRequireConfirmationMap?: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  onEditBot: (botId: number) => void
  onCreateBot: () => void
  onCloneBot: (botId: number) => void
  onOpenPromptDrawer: () => void
}

export default function PipelineModeEditor({
  bots,
  selectedBotKeys,
  setSelectedBotKeys,
  leaderBotId,
  setLeaderBotId,
  unsavedPrompts,
  teamPromptMap,
  isDifyLeader,
  requireConfirmationMap,
  setRequireConfirmationMap,
  onEditBot,
  onCreateBot,
  onCloneBot,
  onOpenPromptDrawer,
}: PipelineModeEditorProps) {
  return (
    <div className="rounded-md border border-border bg-base p-4 flex flex-col flex-1 min-h-0">
      <BotTransfer
        bots={bots}
        selectedBotKeys={selectedBotKeys}
        setSelectedBotKeys={setSelectedBotKeys}
        leaderBotId={leaderBotId}
        setLeaderBotId={setLeaderBotId}
        unsavedPrompts={unsavedPrompts}
        teamPromptMap={teamPromptMap}
        isDifyLeader={isDifyLeader}
        autoSetLeader={true}
        sortable={true}
        requireConfirmationMap={requireConfirmationMap}
        setRequireConfirmationMap={setRequireConfirmationMap}
        onEditBot={onEditBot}
        onCreateBot={onCreateBot}
        onCloneBot={onCloneBot}
        onOpenPromptDrawer={onOpenPromptDrawer}
      />
    </div>
  )
}
