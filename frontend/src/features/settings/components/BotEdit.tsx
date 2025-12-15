// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, {
  useCallback,
  useState,
  useEffect,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Loader2, XIcon, SettingsIcon, Edit } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import McpConfigImportModal from './McpConfigImportModal';
import SkillManagementModal from './skills/SkillManagementModal';
import DifyBotConfig from './DifyBotConfig';

import { Bot } from '@/types/api';
import { botApis, CreateBotRequest, UpdateBotRequest } from '@/apis/bots';
import {
  isPredefinedModel,
  getModelFromConfig,
  getModelTypeFromConfig,
  createPredefinedModelConfig,
} from '@/features/settings/services/bots';
import { modelApis, UnifiedModel, ModelTypeEnum } from '@/apis/models';
import { shellApis, UnifiedShell } from '@/apis/shells';
import { fetchSkillsList } from '@/apis/skills';
import { useTranslation } from 'react-i18next';
import { adaptMcpConfigForAgent, isValidAgentType } from '../utils/mcpTypeAdapter';

/** Agent types supported by the system */
export type AgentType = 'ClaudeCode' | 'Agno' | 'Dify';

/** Interface for bot data returned by getBotData */
export interface BotFormData {
  name: string;
  shell_name: string;
  agent_config: Record<string, unknown>;
  system_prompt: string;
  mcp_servers: Record<string, unknown>;
  skills: string[];
}

/** Interface for validation result */
export interface BotValidationResult {
  isValid: boolean;
  error?: string;
}

/** Ref interface exposed by BotEdit */
export interface BotEditRef {
  /** Get current bot form data */
  getBotData: () => BotFormData | null;
  /** Validate bot form data */
  validateBot: () => BotValidationResult;
  /** Save bot (create or update) and return the bot id */
  saveBot: () => Promise<number | null>;
}

interface BotEditProps {
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  editingBotId: number;
  cloningBot: Bot | null;
  onClose: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  /** Whether the component is embedded in another component (hides back button) */
  embedded?: boolean;
  /** Whether the component is in read-only mode */
  readOnly?: boolean;
  /** Callback when user clicks edit button in read-only mode */
  onEditClick?: () => void;
  /** Callback when user clicks cancel button in edit mode (only for embedded mode) */
  onCancelEdit?: () => void;
  /** List of allowed agent types for filtering. If not provided, all agents are shown */
  allowedAgents?: AgentType[];
  /** Whether to hide action buttons (save/edit/cancel) - useful when parent handles saving */
  hideActions?: boolean;
  /** Scope for filtering shells */
  scope?: 'personal' | 'group' | 'all';
  /** Group name when scope is 'group' */
  groupName?: string;
}
const BotEditInner: React.ForwardRefRenderFunction<BotEditRef, BotEditProps> = (
  {
    bots,
    setBots,
    editingBotId,
    cloningBot,
    onClose,
    toast,
    embedded = false,
    readOnly = false,
    onEditClick,
    onCancelEdit,
    allowedAgents,
    hideActions = false,
    scope,
    groupName,
  },
  ref
) => {
  const { t, i18n } = useTranslation('common');

  const [botSaving, setBotSaving] = useState(false);
  const [shells, setShells] = useState<UnifiedShell[]>([]);
  const [loadingShells, setLoadingShells] = useState(false);
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedModelType, setSelectedModelType] = useState<ModelTypeEnum | undefined>(undefined);
  const [selectedProtocol, setSelectedProtocol] = useState('');

  // Current editing object
  const editingBot = editingBotId > 0 ? bots.find(b => b.id === editingBotId) || null : null;

  const baseBot = useMemo(() => {
    if (editingBot) {
      return editingBot;
    }
    if (editingBotId === 0 && cloningBot) {
      return cloningBot;
    }
    return null;
  }, [editingBot, editingBotId, cloningBot]);

  const [botName, setBotName] = useState(baseBot?.name || '');
  // Use shell_name for the selected shell, fallback to shell_type for backward compatibility
  const [agentName, setAgentName] = useState(baseBot?.shell_name || baseBot?.shell_type || '');
  // Helper function to remove protocol from agent_config for display
  const getAgentConfigWithoutProtocol = (config: Record<string, unknown> | undefined): string => {
    if (!config) return '';

    const { protocol: _, ...rest } = config;
    return Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : '';
  };
  const [agentConfig, setAgentConfig] = useState(
    baseBot?.agent_config ? getAgentConfigWithoutProtocol(baseBot.agent_config) : ''
  );

  const [prompt, setPrompt] = useState(baseBot?.system_prompt || '');
  const [mcpConfig, setMcpConfig] = useState(
    baseBot?.mcp_servers ? JSON.stringify(baseBot.mcp_servers, null, 2) : ''
  );
  const [selectedSkills, setSelectedSkills] = useState<string[]>(baseBot?.skills || []);
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [agentConfigError, setAgentConfigError] = useState(false);
  const [mcpConfigError, setMcpConfigError] = useState(false);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [templateSectionExpanded, setTemplateSectionExpanded] = useState(false);
  const [skillManagementModalOpen, setSkillManagementModalOpen] = useState(false);

  // Check if current agent is Dify
  const isDifyAgent = useMemo(() => agentName === 'Dify', [agentName]);

  const prettifyAgentConfig = useCallback(() => {
    setAgentConfig(prev => {
      const trimmed = prev.trim();
      if (!trimmed) {
        setAgentConfigError(false);
        return '';
      }
      try {
        const parsed = JSON.parse(trimmed);
        setAgentConfigError(false);
        return JSON.stringify(parsed, null, 2);
      } catch {
        toast({
          variant: 'destructive',
          title: t('bot.errors.agent_config_json'),
        });
        setAgentConfigError(true);
        return prev;
      }
    });
  }, [toast, t]);

  const prettifyMcpConfig = useCallback(() => {
    setMcpConfig(prev => {
      const trimmed = prev.trim();
      if (!trimmed) {
        setMcpConfigError(false);
        return '';
      }
      try {
        const parsed = JSON.parse(trimmed);
        setMcpConfigError(false);
        return JSON.stringify(parsed, null, 2);
      } catch {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_json'),
        });
        setMcpConfigError(true);
        return prev;
      }
    });
  }, [toast, t]);

  // Handle MCP configuration import
  const handleImportMcpConfig = useCallback(() => {
    setImportModalVisible(true);
  }, []);

  // Handle import configuration confirmation
  const handleImportConfirm = useCallback(
    (config: Record<string, unknown>, mode: 'replace' | 'append') => {
      try {
        // Update MCP configuration
        if (mode === 'replace') {
          // Replace mode: directly use new configuration
          setMcpConfig(JSON.stringify(config, null, 2));
          toast({
            title: t('bot.import_success'),
          });
        } else {
          // Append mode: merge existing configuration with new configuration
          try {
            const currentConfig = mcpConfig.trim() ? JSON.parse(mcpConfig) : {};
            const mergedConfig = { ...currentConfig, ...config };
            setMcpConfig(JSON.stringify(mergedConfig, null, 2));
            toast({
              title: t('bot.append_success'),
            });
          } catch {
            toast({
              variant: 'destructive',
              title: t('bot.errors.mcp_config_json'),
            });
            return;
          }
        }
        setImportModalVisible(false);
      } catch {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_json'),
        });
      }
    },
    [mcpConfig, toast, t]
  );

  // Template handlers
  const handleApplyClaudeSonnetTemplate = useCallback(() => {
    const template = {
      env: {
        ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4',
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-your-api-key-here',
        ANTHROPIC_API_KEY: 'sk-ant-your-api-key-here',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
      },
    };
    setAgentConfig(JSON.stringify(template, null, 2));
    setAgentConfigError(false);
    toast({
      title: t('bot.template_applied'),
      description: t('bot.please_update_api_key'),
    });
  }, [toast, t]);

  const handleApplyOpenAIGPT4Template = useCallback(() => {
    const template = {
      env: {
        OPENAI_API_KEY: 'sk-your-openai-api-key-here',
        OPENAI_MODEL: 'gpt-4',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
    };
    setAgentConfig(JSON.stringify(template, null, 2));
    setAgentConfigError(false);
    toast({
      title: t('bot.template_applied'),
      description: t('bot.please_update_api_key'),
    });
  }, [toast, t]);

  // Documentation handlers
  const handleOpenModelDocs = useCallback(() => {
    const lang = i18n.language === 'zh-CN' ? 'zh' : 'en';
    const docsUrl = `https://github.com/wecode-ai/wegent/blob/main/docs/${lang}/guides/user/configuring-models.md`;
    window.open(docsUrl, '_blank');
  }, [i18n.language]);

  const handleOpenShellDocs = useCallback(() => {
    const lang = i18n.language === 'zh-CN' ? 'zh' : 'en';
    const docsUrl = `https://github.com/wecode-ai/wegent/blob/main/docs/${lang}/guides/user/configuring-shells.md`;
    window.open(docsUrl, '_blank');
  }, [i18n.language]);

  // Get shells list (including both public and user-defined shells)
  // Get shells list (including both public and user-defined shells)
  useEffect(() => {
    // Wait for scope to be defined before fetching
    if (scope === undefined) {
      return;
    }

    const fetchShells = async () => {
      setLoadingShells(true);
      try {
        const response = await shellApis.getUnifiedShells(scope, groupName);
        // Filter shells based on allowedAgents prop (using shellType as agent type)
        let filteredShells = response.data || [];
        if (allowedAgents && allowedAgents.length > 0) {
          filteredShells = filteredShells.filter(shell =>
            allowedAgents.includes(shell.shellType as AgentType)
          );
        }
        setShells(filteredShells);
      } catch (error) {
        console.error('Failed to fetch shells:', error);
        toast({
          variant: 'destructive',
          title: t('bot.errors.fetch_agents_failed'),
        });
      } finally {
        setLoadingShells(false);
      }
    };

    fetchShells();
  }, [toast, t, allowedAgents, scope, groupName]);
  useEffect(() => {
    // Only fetch skills when agent is ClaudeCode
    if (agentName !== 'ClaudeCode') {
      setAvailableSkills([]);
      setLoadingSkills(false);
      return;
    }

    const fetchSkills = async () => {
      setLoadingSkills(true);
      try {
        const skillsData = await fetchSkillsList();
        setAvailableSkills(skillsData.map(skill => skill.metadata.name));
      } catch {
        toast({
          variant: 'destructive',
          title: t('skills.loading_failed'),
        });
      } finally {
        setLoadingSkills(false);
      }
    };
    fetchSkills();
  }, [agentName, toast, t]);

  // Fetch corresponding model list when agentName changes
  useEffect(() => {
    if (!agentName) {
      setModels([]);
      return;
    }

    const fetchModels = async () => {
      setLoadingModels(true);
      try {
        // Find the selected shell to get its shellType for model filtering
        const selectedShell = shells.find(s => s.name === agentName);
        // Use shell's shellType for model filtering, fallback to agentName for public shells
        const shellType = selectedShell?.shellType || agentName;

        // Use the new unified models API which includes type information
        // Pass scope and groupName to filter models based on current context
        const response = await modelApis.getUnifiedModels(shellType, false, scope, groupName);
        setModels(response.data);

        // After loading models, check if we should restore the bot's saved model
        // This handles the case when editing an existing bot with a predefined model
        // Only restore if the current agentName matches the baseBot's shell_name
        // (i.e., user hasn't switched to a different agent)
        const hasConfig = baseBot?.agent_config && Object.keys(baseBot.agent_config).length > 0;
        // Use shell_name for comparison, fallback to shell_type for backward compatibility
        const baseBotShellName = baseBot?.shell_name || baseBot?.shell_type;
        const agentMatches = baseBotShellName === agentName;
        const isPredefined = hasConfig && isPredefinedModel(baseBot.agent_config);

        if (hasConfig && agentMatches && isPredefined) {
          const savedModelName = getModelFromConfig(baseBot.agent_config);
          const savedModelType = getModelTypeFromConfig(baseBot.agent_config);
          // Only set the model if it exists in the loaded models list
          // Match by both name and type if type is specified
          const foundModel = response.data.find((m: UnifiedModel) => {
            if (savedModelType) {
              return m.name === savedModelName && m.type === savedModelType;
            }
            return m.name === savedModelName;
          });
          if (savedModelName && foundModel) {
            setSelectedModel(savedModelName);
            setSelectedModelType(foundModel.type);
          } else {
            // Model not found in list, clear selection
            setSelectedModel('');
            setSelectedModelType(undefined);
          }
        }
        // Note: Don't clear selectedModel here if agent changed,
        // as it's already cleared in the agent select onChange handler
      } catch (error) {
        console.error('Failed to fetch models:', error);
        toast({
          variant: 'destructive',
          title: t('bot.errors.fetch_models_failed'),
        });
        setModels([]);
        setSelectedModel('');
        setSelectedModelType(undefined);
      } finally {
        setLoadingModels(false);
      }
    };

    fetchModels();
  }, [agentName, shells, toast, t, baseBot]);
  // Reset base form when switching editing object
  useEffect(() => {
    setBotName(baseBot?.name || '');
    // Use shell_name for the selected shell, fallback to shell_type for backward compatibility
    setAgentName(baseBot?.shell_name || baseBot?.shell_type || '');
    setPrompt(baseBot?.system_prompt || '');
    setMcpConfig(baseBot?.mcp_servers ? JSON.stringify(baseBot.mcp_servers, null, 2) : '');
    setSelectedSkills(baseBot?.skills || []);
    setAgentConfigError(false);
    setMcpConfigError(false);

    if (baseBot?.agent_config) {
      // Remove protocol from display - it's managed separately via dropdown
      setAgentConfig(getAgentConfigWithoutProtocol(baseBot.agent_config));
    } else {
      setAgentConfig('');
    }
  }, [editingBotId, baseBot]);

  // Initialize model-related data after agents and models are loaded
  useEffect(() => {
    // Check if agent_config is empty or doesn't exist
    const hasValidConfig = baseBot?.agent_config && Object.keys(baseBot.agent_config).length > 0;

    if (!hasValidConfig) {
      // Default to dropdown (predefined model) mode when no config exists
      setIsCustomModel(false);
      setSelectedModel('');
      setSelectedProtocol('');
      return;
    }

    const isPredefined = isPredefinedModel(baseBot.agent_config);
    setIsCustomModel(!isPredefined);

    if (isPredefined) {
      const modelName = getModelFromConfig(baseBot.agent_config);
      setSelectedModel(modelName);
      setSelectedProtocol('');
    } else {
      setSelectedModel('');
      // Extract protocol from agent_config for custom configs
      const protocol = ((baseBot.agent_config as Record<string, unknown>).protocol as string) || '';
      setSelectedProtocol(protocol);
    }
  }, [baseBot]);

  const handleBack = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      handleBack();
    };

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [handleBack]);

  // Validate bot form data
  const validateBot = useCallback((): BotValidationResult => {
    if (!botName.trim() || !agentName.trim()) {
      return { isValid: false, error: t('bot.errors.required') };
    }

    // For Dify agent, validate config
    if (isDifyAgent) {
      const trimmedConfig = agentConfig.trim();
      if (!trimmedConfig) {
        return { isValid: false, error: t('bot.errors.agent_config_json') };
      }
      try {
        const parsed = JSON.parse(trimmedConfig);
        const env = (parsed as Record<string, unknown>)?.env as Record<string, unknown> | undefined;
        if (!env?.DIFY_API_KEY || !env?.DIFY_BASE_URL) {
          return { isValid: false, error: t('bot.errors.dify_required_fields') };
        }
      } catch {
        return { isValid: false, error: t('bot.errors.agent_config_json') };
      }
    } else if (isCustomModel) {
      if (!selectedProtocol) {
        return { isValid: false, error: t('bot.errors.protocol_required') };
      }
      const trimmedConfig = agentConfig.trim();
      if (!trimmedConfig) {
        return { isValid: false, error: t('bot.errors.agent_config_json') };
      }
      try {
        JSON.parse(trimmedConfig);
      } catch {
        return { isValid: false, error: t('bot.errors.agent_config_json') };
      }
    }

    // Validate MCP config if present (not for Dify)
    if (!isDifyAgent && mcpConfig.trim()) {
      try {
        JSON.parse(mcpConfig);
      } catch {
        return { isValid: false, error: t('bot.errors.mcp_config_json') };
      }
    }

    return { isValid: true };
  }, [botName, agentName, isDifyAgent, agentConfig, isCustomModel, selectedProtocol, mcpConfig, t]);

  // Get bot form data for external use
  const getBotData = useCallback((): BotFormData | null => {
    const validation = validateBot();
    if (!validation.isValid) {
      return null;
    }

    let parsedAgentConfig: Record<string, unknown> = {};

    if (isDifyAgent) {
      parsedAgentConfig = JSON.parse(agentConfig.trim());
    } else if (isCustomModel) {
      const configObj = JSON.parse(agentConfig.trim());
      parsedAgentConfig = { ...configObj, protocol: selectedProtocol };
    } else {
      parsedAgentConfig = createPredefinedModelConfig(selectedModel, selectedModelType) as Record<
        string,
        unknown
      >;
    }

    let parsedMcpConfig: Record<string, unknown> = {};
    if (!isDifyAgent && mcpConfig.trim()) {
      parsedMcpConfig = JSON.parse(mcpConfig);
      if (parsedMcpConfig && agentName && isValidAgentType(agentName)) {
        parsedMcpConfig = adaptMcpConfigForAgent(parsedMcpConfig, agentName);
      }
    }

    return {
      name: botName.trim(),
      shell_name: agentName.trim(),
      agent_config: parsedAgentConfig,
      system_prompt: isDifyAgent ? '' : prompt.trim() || '',
      mcp_servers: parsedMcpConfig,
      skills: selectedSkills.length > 0 ? selectedSkills : [],
    };
  }, [
    validateBot,
    isDifyAgent,
    agentConfig,
    isCustomModel,
    selectedProtocol,
    selectedModel,
    selectedModelType,
    mcpConfig,
    agentName,
    botName,
    prompt,
    selectedSkills,
  ]);

  // Save bot and return the bot id
  const saveBot = useCallback(async (): Promise<number | null> => {
    const validation = validateBot();
    if (!validation.isValid) {
      toast({
        variant: 'destructive',
        title: validation.error,
      });
      return null;
    }

    const botData = getBotData();
    if (!botData) {
      return null;
    }

    setBotSaving(true);
    try {
      const botReq: CreateBotRequest = {
        name: botData.name,
        shell_name: botData.shell_name,
        agent_config: botData.agent_config,
        system_prompt: botData.system_prompt,
        mcp_servers: botData.mcp_servers,
        skills: botData.skills,
        namespace: scope === 'group' && groupName ? groupName : undefined,
      };

      if (editingBotId && editingBotId > 0) {
        const updated = await botApis.updateBot(editingBotId, botReq as UpdateBotRequest);
        setBots(prev => prev.map(b => (b.id === editingBotId ? updated : b)));
        return updated.id;
      } else {
        const created = await botApis.createBot(botReq);
        setBots(prev => [created, ...prev]);
        return created.id;
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('bot.errors.save_failed'),
      });
      return null;
    } finally {
      setBotSaving(false);
    }
  }, [validateBot, getBotData, editingBotId, setBots, toast, t]);

  // Expose methods via ref
  useImperativeHandle(
    ref,
    () => ({
      getBotData,
      validateBot,
      saveBot,
    }),
    [getBotData, validateBot, saveBot]
  );

  // Save logic
  const handleSave = async () => {
    if (!botName.trim() || !agentName.trim()) {
      toast({
        variant: 'destructive',
        title: t('bot.errors.required'),
      });
      return;
    }

    let parsedAgentConfig: unknown = undefined;

    // For Dify agent, always use custom model configuration
    if (isDifyAgent) {
      const trimmedConfig = agentConfig.trim();
      if (!trimmedConfig) {
        setAgentConfigError(true);
        toast({
          variant: 'destructive',
          title: t('bot.errors.agent_config_json'),
        });
        return;
      }
      try {
        parsedAgentConfig = JSON.parse(trimmedConfig);
        setAgentConfigError(false);

        // Validate Dify required fields
        const env = (parsedAgentConfig as Record<string, unknown>)?.env as
          | Record<string, unknown>
          | undefined;
        if (!env?.DIFY_API_KEY || !env?.DIFY_BASE_URL) {
          toast({
            variant: 'destructive',
            title: t('bot.errors.dify_required_fields'),
          });
          return;
        }
      } catch {
        setAgentConfigError(true);
        toast({
          variant: 'destructive',
          title: t('bot.errors.agent_config_json'),
        });
        return;
      }
    } else if (isCustomModel) {
      // Non-Dify custom model configuration
      // Validate protocol is selected
      if (!selectedProtocol) {
        toast({
          variant: 'destructive',
          title: t('bot.errors.protocol_required'),
        });
        return;
      }

      const trimmedConfig = agentConfig.trim();
      if (!trimmedConfig) {
        setAgentConfigError(true);
        toast({
          variant: 'destructive',
          title: t('bot.errors.agent_config_json'),
        });
        return;
      }
      try {
        const configObj = JSON.parse(trimmedConfig);
        // Add protocol to the config
        parsedAgentConfig = { ...configObj, protocol: selectedProtocol };
        setAgentConfigError(false);
      } catch {
        setAgentConfigError(true);
        toast({
          variant: 'destructive',
          title: t('bot.errors.agent_config_json'),
        });
        return;
      }
    } else {
      // Use createPredefinedModelConfig to include bind_model_type
      parsedAgentConfig = createPredefinedModelConfig(selectedModel, selectedModelType);
    }

    let parsedMcpConfig: Record<string, unknown> | null = null;

    // Skip MCP config for Dify agent
    if (!isDifyAgent && mcpConfig.trim()) {
      try {
        parsedMcpConfig = JSON.parse(mcpConfig);
        // Adapt MCP config types based on selected agent
        if (parsedMcpConfig && agentName) {
          if (isValidAgentType(agentName)) {
            parsedMcpConfig = adaptMcpConfigForAgent(parsedMcpConfig, agentName);
          } else {
            console.warn(`Unknown agent type "${agentName}", skipping MCP config adaptation`);
          }
        }
        setMcpConfigError(false);
      } catch {
        setMcpConfigError(true);
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_json'),
        });
        return;
      }
    } else {
      setMcpConfigError(false);
    }

    setBotSaving(true);
    try {
      const botReq: CreateBotRequest = {
        name: botName.trim(),
        shell_name: agentName.trim(), // Use shell_name instead of shell_type
        agent_config: parsedAgentConfig as Record<string, unknown>,
        system_prompt: isDifyAgent ? '' : prompt.trim() || '', // Clear system_prompt for Dify
        mcp_servers: parsedMcpConfig ?? {},
        skills: selectedSkills.length > 0 ? selectedSkills : [],
        namespace: scope === 'group' && groupName ? groupName : undefined,
      };

      if (editingBotId && editingBotId > 0) {
        // Edit existing bot
        const updated = await botApis.updateBot(editingBotId, botReq as UpdateBotRequest);
        setBots(prev => prev.map(b => (b.id === editingBotId ? updated : b)));
      } else {
        // Create new bot
        const created = await botApis.createBot(botReq);
        setBots(prev => [created, ...prev]);
      }
      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('bot.errors.save_failed'),
      });
    } finally {
      setBotSaving(false);
    }
  };
  return (
    <div
      className={`flex flex-col w-full bg-white dark:bg-white/95 rounded-lg px-2 py-4 overflow-hidden ${embedded ? 'h-full min-h-0' : 'min-h-[650px]'}`}
    >
      {/* Top navigation bar */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        {!embedded ? (
          <button
            onClick={handleBack}
            className="flex items-center text-text-muted hover:text-text-primary text-base"
            title={t('common.back')}
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
            {t('common.back')}
          </button>
        ) : (
          <div /> /* Placeholder for flex spacing */
        )}
        {!hideActions &&
          (readOnly ? (
            <Button onClick={onEditClick} variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              {t('actions.edit')}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              {embedded && onCancelEdit && (
                <Button onClick={onCancelEdit} variant="outline">
                  {t('common.cancel')}
                </Button>
              )}
              <Button onClick={handleSave} disabled={botSaving} variant="primary">
                {botSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {botSaving ? t('actions.saving') : t('actions.save')}
              </Button>
            </div>
          ))}
      </div>

      {/* Main content area - using vertical layout */}
      <div className="flex flex-col gap-4 flex-1 mx-2 min-h-0 overflow-y-auto">
        <div className={`flex flex-col space-y-3 w-full flex-shrink-0`}>
          {/* Bot Name and Agent in one row */}
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Bot Name */}
            <div className="flex flex-col flex-1">
              <div className="flex items-center mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('bot.name')} <span className="text-red-400">*</span>
                </label>
              </div>
              <input
                type="text"
                value={botName}
                onChange={e => setBotName(e.target.value)}
                placeholder={t('bot.name_placeholder')}
                disabled={readOnly}
                className={`w-full px-4 py-1 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary text-base ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
              />
            </div>

            {/* Agent */}
            <div className="flex flex-col flex-1">
              <div className="flex items-center mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('bot.agent')} <span className="text-red-400">*</span>
                </label>
                {/* Help Icon */}
                <button
                  type="button"
                  onClick={() => handleOpenShellDocs()}
                  className="ml-2 text-text-muted hover:text-primary transition-colors"
                  title={t('bot.view_shell_config_guide')}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </button>
              </div>
              <Select
                value={agentName}
                onValueChange={value => {
                  if (readOnly) return;
                  if (value !== agentName) {
                    setIsCustomModel(false);
                    setSelectedModel('');
                    setAgentConfig('');
                    setAgentConfigError(false);
                    setModels([]);
                    // Clear protocol when switching agent type since protocols are filtered by agent
                    setSelectedProtocol('');

                    // Adapt MCP config when switching agent type
                    if (mcpConfig.trim()) {
                      try {
                        const currentMcpConfig = JSON.parse(mcpConfig);
                        if (isValidAgentType(value)) {
                          const adaptedConfig = adaptMcpConfigForAgent(currentMcpConfig, value);
                          setMcpConfig(JSON.stringify(adaptedConfig, null, 2));
                        } else {
                          console.warn(
                            `Unknown agent type "${value}", skipping MCP config adaptation`
                          );
                        }
                      } catch (error) {
                        // If parsing fails, keep the original config
                        console.warn('Failed to adapt MCP config on agent change:', error);
                      }
                    }
                  }
                  setAgentName(value);
                }}
                disabled={loadingShells || readOnly}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('bot.agent_select')} />
                </SelectTrigger>
                <SelectContent>
                  {shells.map(shell => (
                    <SelectItem key={`${shell.name}-${shell.type}`} value={shell.name}>
                      {shell.displayName || shell.name}
                      {shell.type === 'user' && (
                        <span className="ml-1 text-xs text-text-muted">
                          [{t('bot.custom_shell', '自定义')}]
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Conditional rendering based on agent type */}
          {isDifyAgent ? (
            /* Dify Mode: Show specialized Dify configuration */
            <DifyBotConfig
              agentConfig={agentConfig}
              onAgentConfigChange={setAgentConfig}
              toast={toast}
              readOnly={readOnly}
            />
          ) : (
            /* Normal Mode: Show standard configuration options */
            <>
              {/* Agent Config */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <label className="block text-base font-medium text-text-primary">
                      {t('bot.agent_config')}
                    </label>
                    {/* Help Icon */}
                    <button
                      type="button"
                      onClick={() => handleOpenModelDocs()}
                      className="text-text-muted hover:text-primary transition-colors"
                      title={t('bot.view_model_config_guide')}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    </button>
                    {/* Template Button - Only show when Custom Model is enabled */}
                    {isCustomModel && (
                      <button
                        type="button"
                        onClick={() => setTemplateSectionExpanded(!templateSectionExpanded)}
                        className="flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
                        title={t('bot.quick_templates')}
                      >
                        <span className="text-sm">📋</span>
                        <span>{t('bot.template')}</span>
                      </button>
                    )}
                  </div>
                  <div className="flex items-center">
                    <span className="text-xs text-text-muted mr-2">{t('bot.advanced_mode')}</span>
                    <Switch
                      checked={isCustomModel}
                      disabled={readOnly}
                      onCheckedChange={(checked: boolean) => {
                        if (readOnly) return;
                        setIsCustomModel(checked);
                        if (checked) {
                          // Clear data when switching to advanced mode
                          setAgentConfig('');
                          setSelectedModel('');
                          setSelectedProtocol('');
                          setAgentConfigError(false);
                        }
                        if (!checked) {
                          setAgentConfigError(false);
                          setTemplateSectionExpanded(false);
                          setSelectedProtocol('');
                        }
                      }}
                    />
                  </div>
                </div>

                {/* Template Expanded Content - Only show when expanded */}
                {isCustomModel && templateSectionExpanded && (
                  <div className="mb-3 bg-base-secondary rounded-md p-3">
                    <div className="flex gap-2 flex-wrap mb-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleApplyClaudeSonnetTemplate()}
                        className="text-xs"
                        type="button"
                      >
                        Claude Sonnet 4 {t('bot.template')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleApplyOpenAIGPT4Template()}
                        className="text-xs"
                        type="button"
                      >
                        OpenAI GPT-4 {t('bot.template')}
                      </Button>
                    </div>
                    <p className="text-xs text-text-muted">⚠️ {t('bot.template_hint')}</p>
                  </div>
                )}

                {/* Protocol selector - only show in advanced mode */}
                {isCustomModel && (
                  <div className="mb-3">
                    <label className="block text-sm font-medium text-text-primary mb-1">
                      {t('bot.protocol')} <span className="text-red-400">*</span>
                    </label>
                    <Select
                      value={selectedProtocol}
                      onValueChange={setSelectedProtocol}
                      disabled={readOnly}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t('bot.protocol_select')} />
                      </SelectTrigger>
                      <SelectContent>
                        {/* Filter protocol options based on agent type */}
                        {agentName === 'ClaudeCode' && (
                          <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                        )}
                        {agentName === 'Agno' && (
                          <>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                            <SelectItem value="gemini">Gemini (Google)</SelectItem>
                          </>
                        )}
                        {/* Show all options if agent type is unknown or not selected */}
                        {agentName !== 'ClaudeCode' && agentName !== 'Agno' && (
                          <>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-text-muted mt-1">{t('bot.protocol_hint')}</p>
                  </div>
                )}

                {isCustomModel ? (
                  <textarea
                    value={agentConfig}
                    onChange={e => {
                      if (readOnly) return;
                      const value = e.target.value;
                      setAgentConfig(value);
                      if (!value.trim()) {
                        setAgentConfigError(false);
                      }
                    }}
                    onBlur={prettifyAgentConfig}
                    rows={4}
                    disabled={readOnly}
                    placeholder={
                      agentName === 'ClaudeCode'
                        ? `{
  "env": {
    "model": "claude",
    "model_id": "xxxxx",
    "api_key": "xxxxxx",
    "base_url": "xxxxxx"
  }
}`
                        : agentName === 'Agno'
                          ? `{
  "env": {
    "model": "openai or claude",
    "model_id": "xxxxxx",
    "api_key": "xxxxxx",
    "base_url": "xxxxxx"
  }
}`
                          : ''
                    }
                    className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 font-mono text-base h-[150px] custom-scrollbar ${agentConfigError ? 'border border-red-400 focus:ring-red-300 focus:border-red-400' : 'border border-border focus:ring-primary/40 focus:border-primary'} ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  />
                ) : (
                  <Select
                    value={selectedModel ? `${selectedModel}:${selectedModelType || ''}` : ''}
                    onValueChange={value => {
                      // Value format: "modelName:modelType"
                      const [modelName, modelType] = value.split(':');
                      setSelectedModel(modelName);
                      setSelectedModelType((modelType as ModelTypeEnum) || undefined);
                    }}
                    disabled={loadingModels || !agentName || models.length === 0 || readOnly}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue
                        placeholder={
                          !agentName
                            ? t('bot.select_executor_first')
                            : models.length === 0
                              ? t('bot.no_available_models')
                              : t('bot.model_select')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {models.length === 0 ? (
                        <div className="py-2 px-3 text-sm text-text-muted text-center">
                          {t('bot.no_available_models')}
                        </div>
                      ) : (
                        models.map(model => (
                          <SelectItem
                            key={`${model.name}:${model.type}`}
                            value={`${model.name}:${model.type}`}
                          >
                            {model.displayName || model.name}
                            {model.type === 'public' && (
                              <span className="ml-1 text-xs text-text-muted">
                                [{t('bot.public_model', '公共')}]
                              </span>
                            )}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Skills Selection - Only show for ClaudeCode agent */}
              {agentName === 'ClaudeCode' && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center">
                      <label className="block text-base font-medium text-text-primary">
                        {t('skills.skills_section')}
                      </label>
                      <span className="text-xs text-text-muted ml-2">
                        {t('skills.skills_optional')}
                      </span>
                      {/* Help Icon for Skills */}
                      <a
                        href="https://www.claude.com/blog/skills"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 text-text-muted hover:text-primary transition-colors"
                        title="Learn more about Claude Skills"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      </a>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSkillManagementModalOpen(true)}
                      className="text-xs"
                    >
                      <SettingsIcon className="w-3 h-3 mr-1" />
                      {t('skills.manage_skills_button')}
                    </Button>
                  </div>
                  <div className="bg-base rounded-md p-2 min-h-[80px]">
                    {loadingSkills ? (
                      <div className="text-sm text-text-muted">{t('skills.loading_skills')}</div>
                    ) : availableSkills.length === 0 ? (
                      <div className="text-sm text-text-muted">
                        {t('skills.no_skills_available')}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Select
                          value=""
                          onValueChange={value => {
                            if (readOnly) return;
                            if (value && !selectedSkills.includes(value)) {
                              setSelectedSkills([...selectedSkills, value]);
                            }
                          }}
                          disabled={readOnly}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('skills.select_skill_to_add')} />
                          </SelectTrigger>
                          <SelectContent>
                            {availableSkills
                              .filter(skill => !selectedSkills.includes(skill))
                              .map(skill => (
                                <SelectItem key={skill} value={skill}>
                                  {skill}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>

                        {selectedSkills.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {selectedSkills.map(skill => (
                              <div
                                key={skill}
                                className="inline-flex items-center gap-1 px-2 py-1 bg-muted rounded-md text-sm"
                              >
                                <span>{skill}</span>
                                <button
                                  onClick={() => {
                                    if (readOnly) return;
                                    setSelectedSkills(selectedSkills.filter(s => s !== skill));
                                  }}
                                  disabled={readOnly}
                                  className={`text-text-muted hover:text-text-primary ${readOnly ? 'cursor-not-allowed opacity-50' : ''}`}
                                >
                                  <XIcon className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* MCP Config */}
              <div className="flex flex-col flex-grow">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center">
                    <label className="block text-base font-medium text-text-primary">
                      {t('bot.mcp_config')}
                    </label>
                  </div>
                  <Button size="sm" onClick={() => handleImportMcpConfig()} className="text-xs">
                    {t('bot.import_mcp_button')}
                  </Button>
                </div>
                <textarea
                  value={mcpConfig}
                  onChange={e => {
                    if (readOnly) return;
                    const value = e.target.value;
                    setMcpConfig(value);
                    if (!value.trim()) {
                      setMcpConfigError(false);
                    }
                  }}
                  onBlur={prettifyMcpConfig}
                  disabled={readOnly}
                  className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 font-mono text-base flex-grow resize-none custom-scrollbar ${mcpConfigError ? 'border border-red-400 focus:ring-red-300 focus:border-red-400' : 'border border-border focus:ring-primary/40 focus:border-primary'} ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  placeholder={`{
  "github": {
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "-e",
      "GITHUB_TOOLSETS",
      "-e",
      "GITHUB_READ_ONLY",
      "ghcr.io/github/github-mcp-server"
    ],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "xxxxxxxxxx",
      "GITHUB_TOOLSETS": "",
      "GITHUB_READ_ONLY": ""
    }
  }
}`}
                />
              </div>
            </>
          )}
        </div>

        {/* Prompt area - below the config section */}
        {!isDifyAgent && (
          <div className="w-full flex flex-col min-h-0">
            <div className="mb-1 flex-shrink-0">
              <div className="flex items-center">
                <label className="block text-base font-medium text-text-primary">
                  {t('bot.prompt')}
                </label>
                <span className="text-xs text-text-muted ml-2">AI prompt</span>
              </div>
            </div>

            {/* textarea occupies all space in the second row */}
            <textarea
              value={prompt}
              onChange={e => {
                if (readOnly) return;
                setPrompt(e.target.value);
              }}
              disabled={readOnly}
              placeholder={t('bot.prompt_placeholder')}
              className={`w-full h-full px-4 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary text-base resize-none custom-scrollbar min-h-[200px] flex-grow ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
            />
          </div>
        )}
      </div>

      {/* MCP Configuration Import Modal */}
      <McpConfigImportModal
        visible={importModalVisible}
        onClose={() => setImportModalVisible(false)}
        onImport={handleImportConfirm}
        toast={toast}
        agentType={agentName as 'ClaudeCode' | 'Agno'}
      />

      {/* Skill Management Modal */}
      <SkillManagementModal
        open={skillManagementModalOpen}
        onClose={() => setSkillManagementModalOpen(false)}
        onSkillsChange={() => {
          // Reload skills list when skills are changed
          const fetchSkills = async () => {
            try {
              const skillsData = await fetchSkillsList();
              setAvailableSkills(skillsData.map(skill => skill.metadata.name));
            } catch {
              toast({
                variant: 'destructive',
                title: t('skills.loading_failed'),
              });
            }
          };
          fetchSkills();
        }}
      />

      {/* Mobile responsive styles */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
          @media (max-width: 640px) {
            /* Mobile specific optimizations */
            .flex.flex-col.w-full.bg-surface.rounded-lg {
              padding: 0.5rem !important;
              border-radius: 0.5rem !important;
              max-width: 100vw !important;
              overflow-x: hidden !important;
              height: 100vh !important;
              min-height: 100vh !important;
              max-height: 100vh !important;
            }

            /* Prevent horizontal scroll on mobile */
            body, html {
              overflow-x: hidden !important;
            }

            /* Ensure container doesn't cause horizontal scroll */
            .max-w-full {
              max-width: 100vw !important;
              overflow-x: hidden !important;
            }

            .overflow-hidden {
              overflow-x: hidden !important;
              overflow-y: auto !important;
            }

            /* Fix main container height on mobile */
            .flex.flex-col.w-full.bg-surface.rounded-lg {
              height: 100vh !important;
              min-height: 100vh !important;
            }

            /* Fix content area to fill remaining height */
            .flex.flex-col.lg\\:flex-row.gap-4.flex-grow.mx-2.min-h-0.overflow-hidden {
              height: calc(100vh - 120px) !important;
              min-height: calc(100vh - 120px) !important;
            }

            /* Adjust input and textarea sizes for mobile */
            input[type="text"] {
              font-size: 16px !important;
              padding: 0.75rem 1rem !important;
              height: auto !important;
              max-width: 100% !important;
              box-sizing: border-box !important;
            }

            textarea {
              font-size: 16px !important;
              padding: 0.75rem 1rem !important;
              min-height: 150px !important;
              max-width: 100% !important;
              box-sizing: border-box !important;
              resize: vertical !important;
              white-space: pre-wrap !important;
              word-wrap: break-word !important;
            }

            /* Adjust button sizes */
            .ant-btn {
              min-height: 40px !important;
              font-size: 14px !important;
              max-width: 100% !important;
              white-space: nowrap !important;
              overflow: hidden !important;
              text-overflow: ellipsis !important;
            }

            /* Adjust select component */
            .ant-select {
              max-width: 100% !important;
            }

            .ant-select-selector {
              min-height: 40px !important;
              font-size: 16px !important;
              max-width: 100% !important;
              box-sizing: border-box !important;
            }

            .ant-select-dropdown {
              max-width: 90vw !important;
              min-width: 200px !important;
            }

            /* Adjust labels */
            label {
              font-size: 16px !important;
              max-width: 100% !important;
              word-wrap: break-word !important;
            }

            /* Reduce spacing on mobile */
            .space-y-3 > * + * {
              margin-top: 0.75rem !important;
            }

            /* Fix overflow issues */
            .overflow-y-auto {
              overflow-x: hidden !important;
              overflow-y: auto !important;
            }

            /* Fix flex container overflow */
            .flex.flex-col {
              min-width: 0 !important;
              max-width: 100% !important;
            }

            .flex-grow {
              min-width: 0 !important;
              max-width: 100% !important;
              flex: 1 !important;
            }

            /* Fix grid and layout overflow */
            .grid {
              max-width: 100% !important;
              overflow-x: hidden !important;
            }

            /* Fix text overflow in containers */
            .truncate {
              overflow: hidden !important;
              text-overflow: ellipsis !important;
              white-space: nowrap !important;
              max-width: 100% !important;
            }

            /* Fix long text in tooltips */
            .ant-tooltip-inner {
              max-width: 80vw !important;
              word-wrap: break-word !important;
              white-space: normal !important;
            }
          }
        `,
        }}
      />
    </div>
  );
};

const BotEdit = forwardRef(BotEditInner);

export default BotEdit;
