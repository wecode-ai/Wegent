// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import type {
  Team,
  GitRepoInfo,
  GitBranch,
  WelcomeConfigResponse,
  ChatSloganItem,
  ChatTipItem,
  MultiAttachmentUploadState,
  DefaultTeamsResponse,
} from '@/types/api'
import type { ContextItem } from '@/types/context'
import type { Model } from '../selector/ModelSelector'
import { useMultiAttachment } from '@/hooks/useMultiAttachment'
import { userApis } from '@/apis/user'
import { correctionApis } from '@/apis/correction'
import { saveLastRepo } from '@/utils/userPreferences'
import { useTaskContext } from '../../contexts/taskContext'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { teamRequiresWorkspace } from '../../service/messageService'

const SHOULD_HIDE_QUOTA_NAME_LIMIT = 18

export interface UseChatAreaStateOptions {
  teams: Team[]
  taskType: 'chat' | 'code' | 'knowledge'
  selectedTeamForNewTask?: Team | null
  /**
   * Initial knowledge base to pre-select when starting a new chat from knowledge page.
   * Note: In notebook mode (taskType === 'knowledge'), this is NOT added to selectedContexts
   * because the notebook's knowledge base is automatically bound to the task on creation.
   */
  initialKnowledgeBase?: {
    id: number
    name: string
    namespace: string
    document_count?: number
  } | null
}

export interface ChatAreaState {
  // Team state
  selectedTeam: Team | null
  setSelectedTeam: (team: Team | null) => void
  handleTeamChange: (team: Team | null) => void

  // Default team state
  defaultTeamsConfig: DefaultTeamsResponse | null
  defaultTeam: Team | null
  isUsingDefaultTeam: boolean
  restoreDefaultTeam: () => void

  // Repository state
  selectedRepo: GitRepoInfo | null
  setSelectedRepo: (repo: GitRepoInfo | null) => void

  // Branch state
  selectedBranch: GitBranch | null
  setSelectedBranch: (branch: GitBranch | null) => void

  // Workspace override state (allows user to override team's default requires_workspace setting)
  requiresWorkspaceOverride: boolean | null
  setRequiresWorkspaceOverride: (value: boolean | null) => void
  effectiveRequiresWorkspace: boolean // Computed: override ?? teamRequiresWorkspace(team)

  // Model state
  selectedModel: Model | null
  setSelectedModel: (model: Model | null) => void
  forceOverride: boolean
  setForceOverride: (value: boolean) => void

  // Input state
  taskInputMessage: string
  setTaskInputMessage: (message: string) => void

  // Loading state
  isLoading: boolean
  setIsLoading: (value: boolean) => void

  // Deep thinking state
  enableDeepThinking: boolean
  setEnableDeepThinking: (value: boolean) => void

  // Clarification state
  enableClarification: boolean
  setEnableClarification: (value: boolean) => void

  // Correction mode state
  enableCorrectionMode: boolean
  correctionModelId: string | null
  correctionModelName: string | null
  enableCorrectionWebSearch: boolean
  handleCorrectionModeToggle: (enabled: boolean, modelId?: string, modelName?: string) => void

  // External API params
  externalApiParams: Record<string, string>
  handleExternalApiParamsChange: (params: Record<string, string>) => void
  appMode: string | undefined
  handleAppModeChange: (mode: string | undefined) => void

  // Attachment state (multi-attachment)
  attachmentState: MultiAttachmentUploadState
  handleFileSelect: (files: File | File[]) => Promise<void>
  handleAttachmentRemove: (attachmentId: number) => Promise<void>
  resetAttachment: () => void
  isAttachmentReadyToSend: boolean
  isUploading: boolean

  // Welcome config
  welcomeConfig: WelcomeConfigResponse | null
  randomSlogan: ChatSloganItem | null
  randomTip: ChatTipItem | null

  // UI state
  isMobile: boolean
  shouldHideQuotaUsage: boolean
  shouldHideChatInput: boolean
  hasRestoredPreferences: boolean
  setHasRestoredPreferences: (value: boolean) => void

  // Drag and drop state
  isDragging: boolean
  setIsDragging: (value: boolean) => void

  // Context selection state (knowledge bases)
  selectedContexts: ContextItem[]
  setSelectedContexts: (contexts: ContextItem[]) => void
  resetContexts: () => void

  // Refs
  initialTeamIdRef: React.MutableRefObject<number | null>

  // Helper functions
  isTeamCompatibleWithMode: (team: Team) => boolean
  findDefaultTeamForMode: (teams: Team[]) => Team | null
}

/**
 * useChatAreaState Hook
 *
 * Manages all the state for the ChatArea component, including:
 * - Team, repository, branch, and model selection
 * - Input message and attachment state
 * - Loading and toggle states (deep thinking, clarification)
 * - External API parameters (for Dify teams)
 * - Welcome config and random slogan/tip
 * - UI state (mobile, quota visibility)
 *
 * This hook extracts all useState calls and related initialization logic
 * from ChatArea to reduce the component size and improve maintainability.
 */
export function useChatAreaState({
  teams: _teams,
  taskType,
  selectedTeamForNewTask,
  initialKnowledgeBase,
}: UseChatAreaStateOptions): ChatAreaState {
  // In notebook mode (taskType === 'knowledge'), don't show the current notebook's KB in selectedContexts
  // because it's automatically bound to the task on creation
  const shouldShowInitialKbInContexts = taskType !== 'knowledge'

  const { selectedTaskDetail } = useTaskContext()

  // Pre-load team preference from localStorage to use as initial value
  const initialTeamIdRef = useRef<number | null>(null)

  // Team state
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false)

  // Default teams configuration (from server)
  const [defaultTeamsConfig, setDefaultTeamsConfig] = useState<DefaultTeamsResponse | null>(null)
  // Track if user is using default team or manually selected one
  const [isUsingDefaultTeam, setIsUsingDefaultTeam] = useState(true)

  // Repository and branch state
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  // Workspace override state (null means use team's default)
  const [requiresWorkspaceOverride, setRequiresWorkspaceOverride] = useState<boolean | null>(null)

  // Model state
  const [selectedModel, setSelectedModel] = useState<Model | null>(null)
  const [forceOverride, setForceOverride] = useState(false)

  // Input state
  const [taskInputMessage, setTaskInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  // Toggle states
  const [enableDeepThinking, setEnableDeepThinking] = useState(true)
  const [enableClarification, setEnableClarification] = useState(false)

  // Correction mode state (persisted in localStorage)
  const [enableCorrectionMode, setEnableCorrectionMode] = useState(false)
  const [correctionModelId, setCorrectionModelId] = useState<string | null>(null)
  const [correctionModelName, setCorrectionModelName] = useState<string | null>(null)
  const [enableCorrectionWebSearch, setEnableCorrectionWebSearch] = useState(false)

  // External API params
  const [externalApiParams, setExternalApiParams] = useState<Record<string, string>>({})
  const [appMode, setAppMode] = useState<string | undefined>(undefined)

  // Welcome config
  const [welcomeConfig, setWelcomeConfig] = useState<WelcomeConfigResponse | null>(null)

  // Drag and drop
  const [isDragging, setIsDragging] = useState(false)

  // Context selection state (knowledge bases)
  const [selectedContexts, setSelectedContexts] = useState<ContextItem[]>([])

  // Reset contexts helper
  const resetContexts = useCallback(() => {
    setSelectedContexts([])
  }, [])

  // Media query
  const isMobile = useMediaQuery('(max-width: 640px)')

  // Attachment state (multi-attachment)
  const {
    state: attachmentState,
    handleFileSelect,
    handleRemove: handleAttachmentRemove,
    reset: resetAttachment,
    isReadyToSend: isAttachmentReadyToSend,
    isUploading,
  } = useMultiAttachment()

  // Refs for random indices (stable across taskType changes)
  const sloganRandomIndexRef = useRef<number | null>(null)
  const tipRandomIndexRef = useRef<number | null>(null)

  // Fetch welcome config
  useEffect(() => {
    const fetchWelcomeConfig = async () => {
      try {
        const response = await userApis.getWelcomeConfig()
        setWelcomeConfig(response)
      } catch (error) {
        console.error('Failed to fetch welcome config:', error)
      }
    }

    fetchWelcomeConfig()
  }, [])

  // Fetch default teams configuration
  useEffect(() => {
    const fetchDefaultTeams = async () => {
      try {
        const response = await userApis.getDefaultTeams()
        setDefaultTeamsConfig(response)
      } catch (error) {
        console.error('Failed to fetch default teams config:', error)
      }
    }

    fetchDefaultTeams()
  }, [])

  // Get random slogan for display
  const randomSlogan = useMemo<ChatSloganItem | null>(() => {
    if (!welcomeConfig?.slogans || welcomeConfig.slogans.length === 0) {
      return null
    }
    const filteredSlogans = welcomeConfig.slogans.filter(slogan => {
      const sloganMode = slogan.mode || 'both'
      return sloganMode === taskType || sloganMode === 'both'
    })

    if (filteredSlogans.length === 0) {
      return null
    }

    if (sloganRandomIndexRef.current === null) {
      sloganRandomIndexRef.current = Math.floor(Math.random() * filteredSlogans.length)
    }
    const index = sloganRandomIndexRef.current % filteredSlogans.length
    return filteredSlogans[index]
  }, [welcomeConfig?.slogans, taskType])

  // Get random tip for placeholder
  const randomTip = useMemo<ChatTipItem | null>(() => {
    if (!welcomeConfig?.tips || welcomeConfig.tips.length === 0) {
      return null
    }
    const filteredTips = welcomeConfig.tips.filter(tip => {
      const tipMode = tip.mode || 'both'
      return tipMode === taskType || tipMode === 'both'
    })

    if (filteredTips.length === 0) {
      return null
    }

    if (tipRandomIndexRef.current === null) {
      tipRandomIndexRef.current = Math.floor(Math.random() * filteredTips.length)
    }
    const index = tipRandomIndexRef.current % filteredTips.length
    return filteredTips[index]
  }, [welcomeConfig?.tips, taskType])

  // Memoized handlers
  const handleExternalApiParamsChange = useCallback((params: Record<string, string>) => {
    setExternalApiParams(params)
  }, [])

  const handleAppModeChange = useCallback((mode: string | undefined) => {
    setAppMode(mode)
  }, [])

  // Handle correction mode toggle
  const handleCorrectionModeToggle = useCallback(
    (enabled: boolean, modelId?: string, modelName?: string) => {
      setEnableCorrectionMode(enabled)
      setCorrectionModelId(modelId || null)
      setCorrectionModelName(modelName || null)
      // When correction mode is enabled, read web search settings from localStorage
      const taskId = selectedTaskDetail?.id ?? null
      if (enabled) {
        const savedState = correctionApis.getCorrectionModeState(taskId)
        setEnableCorrectionWebSearch(savedState.enableWebSearch ?? true)
      } else {
        setEnableCorrectionWebSearch(false)
      }
    },
    [selectedTaskDetail?.id]
  )

  // Check if a team is compatible with the current mode
  const isTeamCompatibleWithMode = useCallback(
    (team: Team): boolean => {
      if (!team.bind_mode || team.bind_mode.length === 0) return false
      return team.bind_mode.includes(taskType)
    },
    [taskType]
  )

  // Get teams compatible with current mode
  const compatibleTeams = useMemo(() => {
    return _teams.filter(isTeamCompatibleWithMode)
  }, [_teams, isTeamCompatibleWithMode])

  // Find default team for current mode from teams list
  // Returns null if no default team is configured for the mode
  const findDefaultTeamForMode = useCallback(
    (teams: Team[]): Team | null => {
      if (teams.length === 0) return null
      if (!defaultTeamsConfig) return null

      // Get the default config for current mode
      const modeKey = taskType as keyof DefaultTeamsResponse
      const defaultConfig = defaultTeamsConfig[modeKey]

      if (!defaultConfig) {
        // No default configured for this mode, return null
        // This allows all teams to be shown in QuickAccessCards
        console.log('[useChatAreaState] No default team configured for mode:', taskType)
        return null
      }

      // Normalize namespace to handle undefined case
      const normalizedNamespace = defaultConfig.namespace || 'default'

      // Find all teams matching name + namespace
      const matchedTeams = teams.filter(
        team =>
          team.name === defaultConfig.name && (team.namespace || 'default') === normalizedNamespace
      )

      if (matchedTeams.length > 0) {
        // Prioritize public team (user_id === 0) over personal team
        const publicTeam = matchedTeams.find(team => team.user_id === 0)
        const selectedTeam = publicTeam || matchedTeams[0]

        console.log(
          '[useChatAreaState] Found default team for mode:',
          taskType,
          selectedTeam.name,
          normalizedNamespace,
          'isPublic:',
          selectedTeam.user_id === 0
        )
        return selectedTeam
      }

      // No match found, return null (configured default team doesn't exist in list)
      console.log(
        '[useChatAreaState] Configured default team not found in list for mode:',
        taskType,
        defaultConfig.name,
        normalizedNamespace
      )
      return null
    },
    [defaultTeamsConfig, taskType]
  )

  // Compute default team for current mode (only from compatible teams)
  const defaultTeam = useMemo(() => {
    return findDefaultTeamForMode(compatibleTeams)
  }, [findDefaultTeamForMode, compatibleTeams])

  // Restore to default team
  const restoreDefaultTeam = useCallback(() => {
    if (defaultTeam) {
      console.log('[useChatAreaState] Restoring to default team:', defaultTeam.name)
      setSelectedTeam(defaultTeam)
      setIsUsingDefaultTeam(true)
      // Reset external API params when restoring
      setExternalApiParams({})
      setAppMode(undefined)
    }
  }, [defaultTeam])

  // Handle team change - marks user as not using default team
  // Also clears repository if the new team doesn't require a workspace
  const handleTeamChange = useCallback(
    (team: Team | null) => {
      console.log('[ChatArea] handleTeamChange called:', team?.name || 'null', team?.id || 'null')
      setSelectedTeam(team)

      // Reset external API params when team changes
      setExternalApiParams({})
      setAppMode(undefined)

      // Only reset workspace override when there's no selected task (new chat scenario)
      // When loading an existing task, preserve the task's repository setting
      if (!selectedTaskDetail) {
        setRequiresWorkspaceOverride(null)

        // Clear repository and branch if the new team doesn't require a workspace
        // This handles switching from code agents (ClaudeCode, Agno) to chat-only agents (Chat, Dify)
        if (team && !teamRequiresWorkspace(team)) {
          console.log('[ChatArea] Team does not require workspace, clearing repo and branch')
          setSelectedRepo(null)
          setSelectedBranch(null)
        }
      }

      // Check if the selected team is the same as the default team
      if (team && defaultTeam && team.id === defaultTeam.id) {
        setIsUsingDefaultTeam(true)
      } else {
        // User manually selected a different team
        setIsUsingDefaultTeam(false)
      }
    },
    [defaultTeam, selectedTaskDetail]
  )

  // Save repository preference when it changes
  useEffect(() => {
    if (selectedRepo) {
      saveLastRepo(selectedRepo.git_repo_id, selectedRepo.git_repo)
    }
  }, [selectedRepo])

  // Sync requiresWorkspaceOverride from task detail when loading an existing task
  // This ensures user's manual repository selection is preserved across page refreshes
  useEffect(() => {
    if (selectedTaskDetail) {
      // If task has git_repo, user selected a repository (requires workspace)
      // If task has no git_repo, user selected "no workspace needed"
      const taskHasRepo = Boolean(selectedTaskDetail.git_repo)
      setRequiresWorkspaceOverride(taskHasRepo)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail?.id]) // Only trigger when task changes, not on every detail update

  // Handle external team selection for new tasks
  useEffect(() => {
    if (selectedTeamForNewTask && !selectedTaskDetail) {
      setSelectedTeam(selectedTeamForNewTask)
    }
  }, [selectedTeamForNewTask, selectedTaskDetail])

  // Initialize selectedContexts with initialKnowledgeBase when starting a new chat
  // This is used when opening chat from knowledge base page
  // Note: In notebook mode (taskType === 'knowledge'), we don't add the current KB to selectedContexts
  // because it's automatically bound to the task on creation and shown in the header
  useEffect(() => {
    // Only initialize when:
    // 1. We have an initialKnowledgeBase
    // 2. No task is currently selected (new chat)
    // 3. selectedContexts is empty (not already initialized)
    // 4. Not in notebook mode (shouldShowInitialKbInContexts is true)
    if (
      shouldShowInitialKbInContexts &&
      initialKnowledgeBase &&
      !selectedTaskDetail &&
      selectedContexts.length === 0
    ) {
      const kbContext: ContextItem = {
        id: initialKnowledgeBase.id,
        name: initialKnowledgeBase.name,
        type: 'knowledge_base',
        document_count: initialKnowledgeBase.document_count,
      }
      setSelectedContexts([kbContext])
    }
  }, [
    shouldShowInitialKbInContexts,
    initialKnowledgeBase,
    selectedTaskDetail,
    selectedContexts.length,
  ])

  // Compute UI flags
  const shouldHideQuotaUsage = useMemo(() => {
    if (!isMobile || !selectedTeam?.name) return false

    if (selectedTeam.share_status === 2 && selectedTeam.user?.user_name) {
      return selectedTeam.name.trim().length > 12
    }

    return selectedTeam.name.trim().length > SHOULD_HIDE_QUOTA_NAME_LIMIT
  }, [selectedTeam, isMobile])

  const shouldHideChatInput = useMemo(() => {
    return appMode === 'workflow'
  }, [appMode])

  // Compute effective requires workspace value
  // Priority: user override > team default
  const effectiveRequiresWorkspace = useMemo(() => {
    if (requiresWorkspaceOverride !== null) {
      return requiresWorkspaceOverride
    }
    return teamRequiresWorkspace(selectedTeam)
  }, [requiresWorkspaceOverride, selectedTeam])

  return {
    // Team state
    selectedTeam,
    setSelectedTeam,
    handleTeamChange,

    // Default team state
    defaultTeamsConfig,
    defaultTeam,
    isUsingDefaultTeam,
    restoreDefaultTeam,

    // Repository state
    selectedRepo,
    setSelectedRepo,

    // Branch state
    selectedBranch,
    setSelectedBranch,

    // Workspace override state
    requiresWorkspaceOverride,
    setRequiresWorkspaceOverride,
    effectiveRequiresWorkspace,

    // Model state
    selectedModel,
    setSelectedModel,
    forceOverride,
    setForceOverride,

    // Input state
    taskInputMessage,
    setTaskInputMessage,

    // Loading state
    isLoading,
    setIsLoading,

    // Deep thinking state
    enableDeepThinking,
    setEnableDeepThinking,

    // Clarification state
    enableClarification,
    setEnableClarification,

    // Correction mode state
    enableCorrectionMode,
    correctionModelId,
    correctionModelName,
    enableCorrectionWebSearch,
    handleCorrectionModeToggle,

    // External API params
    externalApiParams,
    handleExternalApiParamsChange,
    appMode,
    handleAppModeChange,

    // Attachment state (multi-attachment)
    attachmentState,
    handleFileSelect,
    handleAttachmentRemove,
    resetAttachment,
    isAttachmentReadyToSend,
    isUploading,

    // Welcome config
    welcomeConfig,
    randomSlogan,
    randomTip,

    // UI state
    isMobile,
    shouldHideQuotaUsage,
    shouldHideChatInput,
    hasRestoredPreferences,
    setHasRestoredPreferences,

    // Drag and drop state
    isDragging,
    setIsDragging,

    // Context selection state (knowledge bases)
    selectedContexts,
    setSelectedContexts,
    resetContexts,

    // Refs
    initialTeamIdRef,

    // Helper functions
    isTeamCompatibleWithMode,
    findDefaultTeamForMode,
  }
}

export default useChatAreaState
