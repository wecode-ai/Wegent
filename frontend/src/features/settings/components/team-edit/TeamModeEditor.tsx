// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Label } from '@/components/ui/label'
import { Bot, Team } from '@/types/api'
import { UnifiedShell } from '@/apis/shells'
import { TeamMode, AgentType } from '../team-modes'
import { useTranslation } from '@/hooks/useTranslation'
import { BotEditRef } from '../BotEdit'

// Import mode-specific editors
import SoloModeEditor from '../team-modes/SoloModeEditor'
import PipelineModeEditor from '../team-modes/PipelineModeEditor'
import LeaderModeEditor from '../team-modes/LeaderModeEditor'

interface TeamModeEditorProps {
  mode: TeamMode
  filteredBots: Bot[]
  shells: UnifiedShell[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  selectedBotKeys: React.Key[]
  setSelectedBotKeys: React.Dispatch<React.SetStateAction<React.Key[]>>
  leaderBotId: number | null
  setLeaderBotId: React.Dispatch<React.SetStateAction<number | null>>
  editingTeam: Team | null
  editingTeamId: number | null
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  unsavedPrompts: Record<string, string>
  teamPromptMap: Map<number, boolean>
  isDifyLeader: boolean
  leaderOptions: Bot[]
  allowedAgentsForMode?: AgentType[]
  botEditRef: React.RefObject<BotEditRef | null>
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  /** Pipeline mode: requireConfirmation settings for each bot */
  requireConfirmationMap?: Record<number, boolean>
  setRequireConfirmationMap?: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
  onEditBot: (botId: number) => void
  onCreateBot: () => void
  onCloneBot: (botId: number) => void
  onOpenPromptDrawer: () => void
  onLeaderChange: (botId: number) => void
}

export default function TeamModeEditor({
  mode,
  filteredBots,
  shells,
  setBots,
  selectedBotKeys,
  setSelectedBotKeys,
  leaderBotId,
  setLeaderBotId,
  editingTeam,
  editingTeamId,
  toast,
  unsavedPrompts,
  teamPromptMap,
  isDifyLeader,
  leaderOptions,
  allowedAgentsForMode,
  botEditRef,
  scope,
  groupName,
  requireConfirmationMap,
  setRequireConfirmationMap,
  onEditBot,
  onCreateBot,
  onCloneBot,
  onOpenPromptDrawer,
  onLeaderChange,
}: TeamModeEditorProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{t('common:team.members')}</Label>

      <div className="min-h-[300px]">
        {mode === 'solo' && (
          <SoloModeEditor
            bots={filteredBots}
            setBots={setBots}
            selectedBotId={leaderBotId}
            setSelectedBotId={setLeaderBotId}
            editingTeam={editingTeam}
            toast={toast}
            unsavedPrompts={unsavedPrompts}
            teamPromptMap={teamPromptMap}
            onOpenPromptDrawer={onOpenPromptDrawer}
            onCreateBot={onCreateBot}
            allowedAgents={allowedAgentsForMode}
            editingTeamId={editingTeamId ?? undefined}
            botEditRef={botEditRef}
            scope={scope}
            groupName={groupName}
          />
        )}

        {mode === 'pipeline' && (
          <PipelineModeEditor
            bots={filteredBots}
            selectedBotKeys={selectedBotKeys}
            setSelectedBotKeys={setSelectedBotKeys}
            leaderBotId={leaderBotId}
            setLeaderBotId={setLeaderBotId}
            unsavedPrompts={unsavedPrompts}
            teamPromptMap={teamPromptMap}
            isDifyLeader={isDifyLeader}
            requireConfirmationMap={requireConfirmationMap}
            setRequireConfirmationMap={setRequireConfirmationMap}
            toast={toast}
            onEditBot={onEditBot}
            onCreateBot={onCreateBot}
            onCloneBot={onCloneBot}
            onOpenPromptDrawer={onOpenPromptDrawer}
          />
        )}

        {(mode === 'route' || mode === 'coordinate' || mode === 'collaborate') && (
          <LeaderModeEditor
            bots={filteredBots}
            shells={shells}
            selectedBotKeys={selectedBotKeys}
            setSelectedBotKeys={setSelectedBotKeys}
            leaderBotId={leaderBotId}
            setLeaderBotId={setLeaderBotId}
            unsavedPrompts={unsavedPrompts}
            teamPromptMap={teamPromptMap}
            isDifyLeader={isDifyLeader}
            selectedShellType={null}
            leaderOptions={leaderOptions}
            toast={toast}
            onEditBot={onEditBot}
            onCreateBot={onCreateBot}
            onCloneBot={onCloneBot}
            onOpenPromptDrawer={onOpenPromptDrawer}
            onLeaderChange={onLeaderChange}
          />
        )}
      </div>
    </div>
  )
}
