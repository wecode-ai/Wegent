// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Loader2, XIcon, SettingsIcon } from 'lucide-react';
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
import { isPredefinedModel, getModelFromConfig } from '@/features/settings/services/bots';
import { agentApis, Agent } from '@/apis/agents';
import { modelApis, Model } from '@/apis/models';
import { fetchSkillsList } from '@/apis/skills';
import { useTranslation } from 'react-i18next';
import { adaptMcpConfigForAgent, isValidAgentType } from '../utils/mcpTypeAdapter';

interface BotEditProps {
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  editingBotId: number;
  cloningBot: Bot | null;
  onClose: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}
const BotEdit: React.FC<BotEditProps> = ({
  bots,
  setBots,
  editingBotId,
  cloningBot,
  onClose,
  toast,
}) => {
  const { t, i18n } = useTranslation('common');

  const [botSaving, setBotSaving] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');

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
  const [agentName, setAgentName] = useState(baseBot?.agent_name || '');
  const [agentConfig, setAgentConfig] = useState(
    baseBot?.agent_config ? JSON.stringify(baseBot.agent_config, null, 2) : ''
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
    const docsUrl = `/docs/${lang}/guides/user/configuring-models.md`;
    window.open(docsUrl, '_blank');
  }, [i18n.language]);

  const handleOpenShellDocs = useCallback(() => {
    const lang = i18n.language === 'zh-CN' ? 'zh' : 'en';
    const docsUrl = `/docs/${lang}/guides/user/configuring-shells.md`;
    window.open(docsUrl, '_blank');
  }, [i18n.language]);

  // Get agents list
  useEffect(() => {
    const fetchAgents = async () => {
      setLoadingAgents(true);
      try {
        const response = await agentApis.getAgents();
        setAgents(response.items);
      } catch (error) {
        console.error('Failed to fetch agents:', error);
        toast({
          variant: 'destructive',
          title: t('bot.errors.fetch_agents_failed'),
        });
      } finally {
        setLoadingAgents(false);
      }
    };

    fetchAgents();
  }, [toast, t]);

  // Get skills list
  useEffect(() => {
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
  }, [toast, t]);

  // Fetch corresponding model list when agentName changes
  useEffect(() => {
    if (!agentName) {
      setModels([]);
      return;
    }

    const fetchModels = async () => {
      setLoadingModels(true);
      try {
        const response = await modelApis.getModelNames(agentName);
        setModels(response.data);

        // When models list is empty, automatically switch to custom model mode
        if (!response.data || response.data.length === 0) {
          setIsCustomModel(true);
          setSelectedModel('');
        }
      } catch (error) {
        console.error('Failed to fetch models:', error);
        toast({
          variant: 'destructive',
          title: t('bot.errors.fetch_models_failed'),
        });
        // On error, also switch to custom model mode
        setIsCustomModel(true);
        setSelectedModel('');
      } finally {
        setLoadingModels(false);
      }
    };

    fetchModels();
  }, [agentName, toast, t]);
  // Reset base form when switching editing object
  useEffect(() => {
    setBotName(baseBot?.name || '');
    setAgentName(baseBot?.agent_name || '');
    setPrompt(baseBot?.system_prompt || '');
    setMcpConfig(baseBot?.mcp_servers ? JSON.stringify(baseBot.mcp_servers, null, 2) : '');
    setSelectedSkills(baseBot?.skills || []);
    setAgentConfigError(false);
    setMcpConfigError(false);

    if (baseBot?.agent_config) {
      setAgentConfig(JSON.stringify(baseBot.agent_config, null, 2));
    } else {
      setAgentConfig('');
    }
  }, [editingBotId, baseBot]);

  // Initialize model-related data after agents and models are loaded
  useEffect(() => {
    if (!baseBot?.agent_config) {
      setIsCustomModel(false);
      setSelectedModel('');
      return;
    }

    const isPredefined = isPredefinedModel(baseBot.agent_config);
    setIsCustomModel(!isPredefined);

    if (isPredefined) {
      const modelName = getModelFromConfig(baseBot.agent_config);
      setSelectedModel(modelName);
    } else {
      setSelectedModel('');
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
      } catch {
        setAgentConfigError(true);
        toast({
          variant: 'destructive',
          title: t('bot.errors.agent_config_json'),
        });
        return;
      }
    } else {
      parsedAgentConfig = { private_model: selectedModel };
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
        agent_name: agentName.trim(),
        agent_config: parsedAgentConfig as Record<string, unknown>,
        system_prompt: isDifyAgent ? '' : prompt.trim() || '', // Clear system_prompt for Dify
        mcp_servers: parsedMcpConfig ?? {},
        skills: selectedSkills.length > 0 ? selectedSkills : [],
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
    <div className="flex flex-col w-full bg-surface rounded-lg px-2 py-4 min-h-[650px] overflow-hidden">
      {/* Top navigation bar */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
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
        <Button onClick={handleSave} disabled={botSaving}>
          {botSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {botSaving ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>

      {/* Main content area - using responsive layout */}
      <div className="flex flex-col lg:flex-row gap-4 flex-grow mx-2 min-h-0 overflow-hidden">
        <div className={`flex flex-col space-y-3 overflow-y-auto flex-shrink-0 ${isDifyAgent ? 'w-full' : 'w-full lg:w-2/5 xl:w-1/3'}`}>
          {/* Bot Name */}
          <div className="flex flex-col">
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
              className="w-full px-4 py-1 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base"
            />
          </div>

          {/* Agent */}
          <div className="flex flex-col">
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
                if (value !== agentName) {
                  setIsCustomModel(false);
                  setSelectedModel('');
                  setAgentConfig('');
                  setAgentConfigError(false);
                  setModels([]);

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
              disabled={loadingAgents}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('bot.agent_select')} />
              </SelectTrigger>
              <SelectContent>
                {agents.map(agent => (
                  <SelectItem key={agent.name} value={agent.name}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Conditional rendering based on agent type */}
          {isDifyAgent ? (
            /* Dify Mode: Show specialized Dify configuration */
            <div className="w-full max-w-[800px]">
              <DifyBotConfig
                agentConfig={agentConfig}
                onAgentConfigChange={setAgentConfig}
                toast={toast}
              />
            </div>
          ) : (
            /* Normal Mode: Show standard configuration options */
            <>
              {/* Agent Config */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <label className="block text-base font-medium text-text-primary">
                      {t('bot.agent_config')} <span className="text-red-400">*</span>
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
                    <span className="text-xs text-text-muted mr-2">{t('bot.use_custom_model')}</span>
                    <Switch
                      checked={isCustomModel}
                      onCheckedChange={(checked: boolean) => {
                        setIsCustomModel(checked);
                        if (checked) {
                          setAgentConfig('');
                          setAgentConfigError(false);
                        }
                        if (!checked) {
                          setAgentConfigError(false);
                          setTemplateSectionExpanded(false);
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

                {isCustomModel ? (
                  <textarea
                    value={agentConfig}
                    onChange={e => {
                      const value = e.target.value;
                      setAgentConfig(value);
                      if (!value.trim()) {
                        setAgentConfigError(false);
                      }
                    }}
                    onBlur={prettifyAgentConfig}
                    rows={4}
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
    "model": "openai",
    "model_id": "xxxxxx",
    "api_key": "xxxxxx",
    "base_url": "xxxxxx"
  }
}`
                          : ''
                    }
                    className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 font-mono text-base h-[150px] custom-scrollbar ${agentConfigError ? 'border border-red-400 focus:ring-red-300 focus:border-red-400' : 'border border-transparent focus:ring-primary/40 focus:border-transparent'}`}
                  />
                ) : (
                  <Select
                    value={selectedModel}
                    onValueChange={value => {
                      setSelectedModel(value);
                    }}
                    disabled={loadingModels}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('bot.agent_select')} />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map(model => (
                        <SelectItem key={model.name} value={model.name}>
                          {model.name}
                        </SelectItem>
                      ))}
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
                  <div className="text-sm text-text-muted">{t('skills.no_skills_available')}</div>
                ) : (
                  <div className="space-y-2">
                    <Select
                      value=""
                      onValueChange={value => {
                        if (value && !selectedSkills.includes(value)) {
                          setSelectedSkills([...selectedSkills, value]);
                        }
                      }}
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
                              onClick={() =>
                                setSelectedSkills(selectedSkills.filter(s => s !== skill))
                              }
                              className="text-text-muted hover:text-text-primary"
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
                    const value = e.target.value;
                    setMcpConfig(value);
                    if (!value.trim()) {
                      setMcpConfigError(false);
                    }
                  }}
                  onBlur={prettifyMcpConfig}
                  className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 font-mono text-base flex-grow resize-none custom-scrollbar ${mcpConfigError ? 'border border-red-400 focus:ring-red-300 focus:border-red-400' : 'border border-transparent focus:ring-primary/40 focus:border-transparent'}`}
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

        {/* Right Prompt area - responsive layout */}
        {!isDifyAgent && (
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col min-h-0">
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
              onChange={e => setPrompt(e.target.value)}
              placeholder={t('bot.prompt_placeholder')}
              className="w-full h-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base resize-none custom-scrollbar min-h-[200px] flex-grow"
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
          @media (max-width: 1024px) {
            /* Stack layout on tablet and mobile */
            .flex.flex-col.lg\\:flex-row {
              flex-direction: column !important;
            }
            .w-full.lg\\:w-2\\/5.xl\\:w-1\\/3 {
              width: 100% !important;
              margin-bottom: 1rem;
            }
            .w-full.lg\\:w-3\\/5.xl\\:w-2\\/3 {
              width: 100% !important;
            }
            /* Ensure max-width wrapper works on mobile */
            .max-w-\\[800px\\] {
              max-width: 100% !important;
            }
          }

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

export default BotEdit;
