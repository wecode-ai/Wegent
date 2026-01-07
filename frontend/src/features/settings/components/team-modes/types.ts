// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, Team } from '@/types/api'

export type TeamMode = 'solo' | 'pipeline' | 'route' | 'coordinate' | 'collaborate'

export interface TeamModeEditorProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  selectedBotKeys: React.Key[]
  setSelectedBotKeys: React.Dispatch<React.SetStateAction<React.Key[]>>
  leaderBotId: number | null
  setLeaderBotId: React.Dispatch<React.SetStateAction<number | null>>
  editingTeam: Team | null
  unsavedPrompts: Record<string, string>
  setUnsavedPrompts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  teamPromptMap: Map<number, boolean>
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  onEditBot: (botId: number) => void
  onCreateBot: () => void
  onCloneBot: (botId: number) => void
  onOpenPromptDrawer: () => void
}

export interface SoloModeEditorProps extends TeamModeEditorProps {
  // Solo mode specific: bot editing state
  isEditingBot: boolean
  setIsEditingBot: React.Dispatch<React.SetStateAction<boolean>>
}

export interface TransferModeEditorProps extends TeamModeEditorProps {
  // For modes that use Transfer component
  isDifyLeader: boolean
  selectedAgentName: string | null
}

export interface LeaderModeEditorProps extends TransferModeEditorProps {
  // For modes that have leader selection (route, coordinate, collaborate)
  leaderOptions: Bot[]
}
