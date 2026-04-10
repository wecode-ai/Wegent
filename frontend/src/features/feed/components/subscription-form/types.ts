// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for SubscriptionForm components
 */

import type { Team, GitRepoInfo, GitBranch, SearchUser } from '@/types/api'
import type {
  NotificationChannelBindingConfig,
  NotificationChannelInfo,
  NotificationLevel,
  NotificationWebhook,
  SubscriptionExecutionTarget,
  SubscriptionKnowledgeBaseRef,
  SubscriptionSkillRef,
  SubscriptionTriggerType,
  SubscriptionVisibility,
} from '@/types/subscription'
import type { UnifiedSkill } from '@/apis/skills'
import type { DeviceInfo } from '@/apis/devices'

// Model type for selector
export interface SubscriptionModel {
  name: string
  displayName?: string | null
  provider?: string
  modelId?: string
  type?: string
}

// Props for Send Area Section (renamed to Task Settings)
export interface SendAreaSectionProps {
  // Execution Target (moved here, displayed first as "执行位置")
  executionTarget: SubscriptionExecutionTarget
  setExecutionTarget: (value: SubscriptionExecutionTarget) => void
  availableDevices: DeviceInfo[]
  devicesLoading: boolean
  // Prompt
  promptTemplate: string
  setPromptTemplate: (value: string) => void
  // Team
  teamId: number | null
  setTeamId: (value: number | null) => void
  teams: Team[]
  teamsLoading: boolean
  // Model
  selectedModel: SubscriptionModel | null
  setSelectedModel: (value: SubscriptionModel | null) => void
  models: SubscriptionModel[]
  modelsLoading: boolean
  modelRequired: boolean
  compatibleProvider: string | undefined
  // Skills
  skillRefs: SubscriptionSkillRef[]
  setSkillRefs: React.Dispatch<React.SetStateAction<SubscriptionSkillRef[]>>
  availableSkills: UnifiedSkill[]
  skillsLoading: boolean
  // Knowledge Base
  knowledgeBaseRefs: SubscriptionKnowledgeBaseRef[]
  setKnowledgeBaseRefs: (value: SubscriptionKnowledgeBaseRef[]) => void
  // Preserve History
  preserveHistory: boolean
  setPreserveHistory: (value: boolean) => void
  // History Message Count
  historyMessageCount: number
  setHistoryMessageCount: (value: number) => void
  // Rental flag
  isRental: boolean
}

// Props for Meta Info Section
export interface MetaInfoSectionProps {
  displayName: string
  setDisplayName: (value: string) => void
  description: string
  setDescription: (value: string) => void
  enabled: boolean
  setEnabled: (value: boolean) => void
  visibility: SubscriptionVisibility
  setVisibility: (value: SubscriptionVisibility) => void
  marketWhitelistUsers: SearchUser[]
  setMarketWhitelistUsers: (value: SearchUser[]) => void
  isRental: boolean
}

// Expiration type for subscription
export type SubscriptionExpirationType = 'none' | 'fixed_date' | 'duration_days'

// Props for Subscription Options Section
export interface SubscriptionOptionsSectionProps {
  // Trigger
  triggerType: SubscriptionTriggerType
  setTriggerType: (value: SubscriptionTriggerType) => void
  triggerConfig: Record<string, unknown>
  setTriggerConfig: (value: Record<string, unknown>) => void
  // Repository (for code-type teams)
  isCodeTypeTeam: boolean
  selectedRepo: GitRepoInfo | null
  setSelectedRepo: (value: GitRepoInfo | null) => void
  selectedBranch: GitBranch | null
  setSelectedBranch: (value: GitBranch | null) => void
  // Retry & Timeout
  retryCount: number
  setRetryCount: (value: number) => void
  timeoutSeconds: number
  setTimeoutSeconds: (value: number) => void
  // Expiration settings
  expirationType: SubscriptionExpirationType
  setExpirationType: (value: SubscriptionExpirationType) => void
  expirationDate?: Date
  setExpirationDate: (value: Date | undefined) => void
  durationDays: number
  setDurationDays: (value: number) => void
}

// Props for Notification Section
export interface NotificationSectionProps {
  devNotificationLevel: NotificationLevel
  setDevNotificationLevel: (value: NotificationLevel) => void
  devNotificationChannels: number[]
  setDevNotificationChannels: React.Dispatch<React.SetStateAction<number[]>>
  devAvailableChannels: NotificationChannelInfo[]
  devSettingsLoading: boolean
  notificationWebhooks: NotificationWebhook[]
  setNotificationWebhooks: React.Dispatch<React.SetStateAction<NotificationWebhook[]>>
  channelBindingConfigs: NotificationChannelBindingConfig[]
  setChannelBindingConfigs: React.Dispatch<React.SetStateAction<NotificationChannelBindingConfig[]>>
  onStartBinding: (channelId: number, bindPrivate: boolean, bindGroup: boolean) => Promise<void>
  onCancelBinding: (channelId: number) => Promise<void>
  bindingWaitingState: Record<number, boolean>
}
