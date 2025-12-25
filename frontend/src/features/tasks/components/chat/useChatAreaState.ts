// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import type {
  Team,
  GitRepoInfo,
  GitBranch,
  WelcomeConfigResponse,
  ChatSloganItem,
  ChatTipItem,
  MultiAttachmentUploadState,
} from '@/types/api';
import type { ContextItem } from '@/types/context';
import type { Model } from '../selector/ModelSelector';
import { useMultiAttachment } from '@/hooks/useMultiAttachment';
import { userApis } from '@/apis/user';
import { getLastTeamIdByMode, saveLastTeamByMode, saveLastRepo } from '@/utils/userPreferences';
import { useTaskContext } from '../../contexts/taskContext';
import { useMediaQuery } from '@/hooks/useMediaQuery';

const SHOULD_HIDE_QUOTA_NAME_LIMIT = 18;

export interface UseChatAreaStateOptions {
  teams: Team[];
  taskType: 'chat' | 'code';
  selectedTeamForNewTask?: Team | null;
}

export interface ChatAreaState {
  // Team state
  selectedTeam: Team | null;
  setSelectedTeam: (team: Team | null) => void;
  handleTeamChange: (team: Team | null) => void;

  // Repository state
  selectedRepo: GitRepoInfo | null;
  setSelectedRepo: (repo: GitRepoInfo | null) => void;

  // Branch state
  selectedBranch: GitBranch | null;
  setSelectedBranch: (branch: GitBranch | null) => void;

  // Model state
  selectedModel: Model | null;
  setSelectedModel: (model: Model | null) => void;
  forceOverride: boolean;
  setForceOverride: (value: boolean) => void;

  // Input state
  taskInputMessage: string;
  setTaskInputMessage: (message: string) => void;

  // Loading state
  isLoading: boolean;
  setIsLoading: (value: boolean) => void;

  // Deep thinking state
  enableDeepThinking: boolean;
  setEnableDeepThinking: (value: boolean) => void;

  // Clarification state
  enableClarification: boolean;
  setEnableClarification: (value: boolean) => void;

  // External API params
  externalApiParams: Record<string, string>;
  handleExternalApiParamsChange: (params: Record<string, string>) => void;
  appMode: string | undefined;
  handleAppModeChange: (mode: string | undefined) => void;

  // Attachment state (multi-attachment)
  attachmentState: MultiAttachmentUploadState;
  handleFileSelect: (files: File | File[]) => Promise<void>;
  handleAttachmentRemove: (attachmentId: number) => Promise<void>;
  resetAttachment: () => void;
  isAttachmentReadyToSend: boolean;
  isUploading: boolean;

  // Welcome config
  welcomeConfig: WelcomeConfigResponse | null;
  randomSlogan: ChatSloganItem | null;
  randomTip: ChatTipItem | null;

  // UI state
  isMobile: boolean;
  shouldHideQuotaUsage: boolean;
  shouldHideChatInput: boolean;
  hasRestoredPreferences: boolean;
  setHasRestoredPreferences: (value: boolean) => void;

  // Drag and drop state
  isDragging: boolean;
  setIsDragging: (value: boolean) => void;

  // Context selection state (knowledge bases)
  selectedContexts: ContextItem[];
  setSelectedContexts: (contexts: ContextItem[]) => void;

  // Refs
  initialTeamIdRef: React.MutableRefObject<number | null>;

  // Helper functions
  isTeamCompatibleWithMode: (team: Team) => boolean;
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
}: UseChatAreaStateOptions): ChatAreaState {
  const { selectedTaskDetail } = useTaskContext();

  // Pre-load team preference from localStorage to use as initial value
  const initialTeamIdRef = useRef<number | null>(null);
  if (initialTeamIdRef.current === null && typeof window !== 'undefined') {
    initialTeamIdRef.current = getLastTeamIdByMode(taskType);
  }

  // Team state
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false);

  // Repository and branch state
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null);

  // Model state
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [forceOverride, setForceOverride] = useState(false);

  // Input state
  const [taskInputMessage, setTaskInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Toggle states
  const [enableDeepThinking, setEnableDeepThinking] = useState(true);
  const [enableClarification, setEnableClarification] = useState(false);

  // External API params
  const [externalApiParams, setExternalApiParams] = useState<Record<string, string>>({});
  const [appMode, setAppMode] = useState<string | undefined>(undefined);

  // Welcome config
  const [welcomeConfig, setWelcomeConfig] = useState<WelcomeConfigResponse | null>(null);

  // Drag and drop
  const [isDragging, setIsDragging] = useState(false);

  // Context selection state (knowledge bases)
  const [selectedContexts, setSelectedContexts] = useState<ContextItem[]>([]);

  // Media query
  const isMobile = useMediaQuery('(max-width: 640px)');

  // Attachment state (multi-attachment)
  const {
    state: attachmentState,
    handleFileSelect,
    handleRemove: handleAttachmentRemove,
    reset: resetAttachment,
    isReadyToSend: isAttachmentReadyToSend,
    isUploading,
  } = useMultiAttachment();

  // Refs for random indices (stable across taskType changes)
  const sloganRandomIndexRef = useRef<number | null>(null);
  const tipRandomIndexRef = useRef<number | null>(null);

  // Fetch welcome config
  useEffect(() => {
    const fetchWelcomeConfig = async () => {
      try {
        const response = await userApis.getWelcomeConfig();
        setWelcomeConfig(response);
      } catch (error) {
        console.error('Failed to fetch welcome config:', error);
      }
    };

    fetchWelcomeConfig();
  }, []);

  // Get random slogan for display
  const randomSlogan = useMemo<ChatSloganItem | null>(() => {
    if (!welcomeConfig?.slogans || welcomeConfig.slogans.length === 0) {
      return null;
    }
    const filteredSlogans = welcomeConfig.slogans.filter(slogan => {
      const sloganMode = slogan.mode || 'both';
      return sloganMode === taskType || sloganMode === 'both';
    });

    if (filteredSlogans.length === 0) {
      return null;
    }

    if (sloganRandomIndexRef.current === null) {
      sloganRandomIndexRef.current = Math.floor(Math.random() * filteredSlogans.length);
    }
    const index = sloganRandomIndexRef.current % filteredSlogans.length;
    return filteredSlogans[index];
  }, [welcomeConfig?.slogans, taskType]);

  // Get random tip for placeholder
  const randomTip = useMemo<ChatTipItem | null>(() => {
    if (!welcomeConfig?.tips || welcomeConfig.tips.length === 0) {
      return null;
    }
    const filteredTips = welcomeConfig.tips.filter(tip => {
      const tipMode = tip.mode || 'both';
      return tipMode === taskType || tipMode === 'both';
    });

    if (filteredTips.length === 0) {
      return null;
    }

    if (tipRandomIndexRef.current === null) {
      tipRandomIndexRef.current = Math.floor(Math.random() * filteredTips.length);
    }
    const index = tipRandomIndexRef.current % filteredTips.length;
    return filteredTips[index];
  }, [welcomeConfig?.tips, taskType]);

  // Memoized handlers
  const handleExternalApiParamsChange = useCallback((params: Record<string, string>) => {
    setExternalApiParams(params);
  }, []);

  const handleAppModeChange = useCallback((mode: string | undefined) => {
    setAppMode(mode);
  }, []);

  // Check if a team is compatible with the current mode
  const isTeamCompatibleWithMode = useCallback(
    (team: Team): boolean => {
      if (!team.bind_mode || team.bind_mode.length === 0) return false;
      return team.bind_mode.includes(taskType);
    },
    [taskType]
  );

  // Handle team change with localStorage persistence
  const handleTeamChange = useCallback(
    (team: Team | null) => {
      console.log('[ChatArea] handleTeamChange called:', team?.name || 'null', team?.id || 'null');
      setSelectedTeam(team);

      // Reset external API params when team changes
      setExternalApiParams({});
      setAppMode(undefined);

      // Save team preference to localStorage by mode
      if (team && team.id) {
        console.log('[ChatArea] Saving team to localStorage for mode:', taskType, team.id);
        saveLastTeamByMode(team.id, taskType);
      }
    },
    [taskType]
  );

  // Save repository preference when it changes
  useEffect(() => {
    if (selectedRepo) {
      saveLastRepo(selectedRepo.git_repo_id, selectedRepo.git_repo);
    }
  }, [selectedRepo]);

  // Handle external team selection for new tasks
  useEffect(() => {
    if (selectedTeamForNewTask && !selectedTaskDetail) {
      setSelectedTeam(selectedTeamForNewTask);
    }
  }, [selectedTeamForNewTask, selectedTaskDetail]);

  // Compute UI flags
  const shouldHideQuotaUsage = useMemo(() => {
    if (!isMobile || !selectedTeam?.name) return false;

    if (selectedTeam.share_status === 2 && selectedTeam.user?.user_name) {
      return selectedTeam.name.trim().length > 12;
    }

    return selectedTeam.name.trim().length > SHOULD_HIDE_QUOTA_NAME_LIMIT;
  }, [selectedTeam, isMobile]);

  const shouldHideChatInput = useMemo(() => {
    return appMode === 'workflow';
  }, [appMode]);

  return {
    // Team state
    selectedTeam,
    setSelectedTeam,
    handleTeamChange,

    // Repository state
    selectedRepo,
    setSelectedRepo,

    // Branch state
    selectedBranch,
    setSelectedBranch,

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

    // Refs
    initialTeamIdRef,

    // Helper functions
    isTeamCompatibleWithMode,
  };
}

export default useChatAreaState;
