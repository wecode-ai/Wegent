// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { Button, Select, Switch } from 'antd';
import McpConfigImportModal from './McpConfigImportModal';

import { Bot } from '@/types/api';
import { botApis, CreateBotRequest, UpdateBotRequest } from '@/apis/bots';
import { isPredefinedModel, getModelFromConfig } from '@/features/settings/services/bots';
import { agentApis, Agent } from '@/apis/agents';
import { modelApis, Model } from '@/apis/models';
import { useTranslation } from 'react-i18next';
import { adaptMcpConfigForAgent, isValidAgentType } from '../utils/mcpTypeAdapter';

import type { MessageInstance } from 'antd/es/message/interface';

interface BotEditProps {
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  editingBotId: number;
  cloningBot: Bot | null;
  onClose: () => void;
  message: MessageInstance;
}
const BotEdit: React.FC<BotEditProps> = ({
  bots,
  setBots,
  editingBotId,
  cloningBot,
  onClose,
  message,
}) => {
  const { t } = useTranslation('common');

  const [botSaving, setBotSaving] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');

  // Convert agents to options format for Select component
  const agentOptions = agents.map(agent => ({
    value: agent.name,
    label: agent.name,
  }));

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
  const [agentConfigError, setAgentConfigError] = useState(false);
  const [mcpConfigError, setMcpConfigError] = useState(false);
  const [importModalVisible, setImportModalVisible] = useState(false);

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
        message.error(t('bot.errors.agent_config_json'));
        setAgentConfigError(true);
        return prev;
      }
    });
  }, [message, t]);

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
        message.error(t('bot.errors.mcp_config_json'));
        setMcpConfigError(true);
        return prev;
      }
    });
  }, [message, t]);

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
          message.success(t('bot.import_success'));
        } else {
          // Append mode: merge existing configuration with new configuration
          try {
            const currentConfig = mcpConfig.trim() ? JSON.parse(mcpConfig) : {};
            const mergedConfig = { ...currentConfig, ...config };
            setMcpConfig(JSON.stringify(mergedConfig, null, 2));
            message.success(t('bot.append_success'));
          } catch {
            message.error(t('bot.errors.mcp_config_json'));
            return;
          }
        }
        setImportModalVisible(false);
      } catch {
        message.error(t('bot.errors.mcp_config_json'));
      }
    },
    [mcpConfig, message, t]
  );

  // Get agents list
  useEffect(() => {
    const fetchAgents = async () => {
      setLoadingAgents(true);
      try {
        const response = await agentApis.getAgents();
        setAgents(response.items);
      } catch (error) {
        console.error('Failed to fetch agents:', error);
        message.error(t('bot.errors.fetch_agents_failed'));
      } finally {
        setLoadingAgents(false);
      }
    };

    fetchAgents();
  }, [message, t]);

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
        message.error(t('bot.errors.fetch_models_failed'));
        // On error, also switch to custom model mode
        setIsCustomModel(true);
        setSelectedModel('');
      } finally {
        setLoadingModels(false);
      }
    };

    fetchModels();
  }, [agentName, message, t]);

  // Reset base form when switching editing object
  useEffect(() => {
    setBotName(baseBot?.name || '');
    setAgentName(baseBot?.agent_name || '');
    setPrompt(baseBot?.system_prompt || '');
    setMcpConfig(baseBot?.mcp_servers ? JSON.stringify(baseBot.mcp_servers, null, 2) : '');
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
      message.error(t('bot.errors.required'));
      return;
    }
    let parsedAgentConfig: unknown = undefined;
    if (isCustomModel) {
      const trimmedConfig = agentConfig.trim();
      if (!trimmedConfig) {
        setAgentConfigError(true);
        message.error(t('bot.errors.agent_config_json'));
        return;
      }
      try {
        parsedAgentConfig = JSON.parse(trimmedConfig);
        setAgentConfigError(false);
      } catch {
        setAgentConfigError(true);
        message.error(t('bot.errors.agent_config_json'));
        return;
      }
    } else {
      parsedAgentConfig = { private_model: selectedModel };
    }

    let parsedMcpConfig: Record<string, unknown> | null = null;
    if (mcpConfig.trim()) {
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
        message.error(t('bot.errors.mcp_config_json'));
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
        system_prompt: prompt.trim() || '',
        mcp_servers: parsedMcpConfig ?? {},
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
      message.error((error as Error)?.message || t('bot.errors.save_failed'));
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

        <Button onClick={handleSave} disabled={botSaving} loading={botSaving} type="primary">
          {botSaving ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>

      {/* Main content area - using responsive layout */}
      <div className="flex flex-col lg:flex-row gap-4 flex-grow mx-2 min-h-0 overflow-hidden">
        <div className="flex flex-col space-y-3 overflow-y-auto w-full lg:w-2/5 xl:w-1/3 flex-shrink-0">
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
            </div>
            <Select
              value={agentName}
              onChange={value => {
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
              placeholder="choose an agent"
              style={{ width: '100%' }}
              options={agentOptions}
              loading={loadingAgents}
              optionRender={option => <div>{option.data.label}</div>}
            />
          </div>

          {/* Agent Config */}
          <div className="flex flex-col">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center">
                <label className="block text-base font-medium text-text-primary">
                  {t('bot.agent_config')} <span className="text-red-400">*</span>
                </label>
              </div>
              <div className="flex items-center">
                <span className="text-xs text-text-muted mr-2">{t('bot.use_custom_model')}</span>
                <Switch
                  size="small"
                  checked={isCustomModel}
                  onChange={checked => {
                    setIsCustomModel(checked);
                    if (checked) {
                      setAgentConfig('');
                      setAgentConfigError(false);
                    }
                    if (!checked) {
                      setAgentConfigError(false);
                    }
                  }}
                />
              </div>
            </div>

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
                onChange={value => {
                  setSelectedModel(value);
                }}
                placeholder="Select a model"
                style={{ width: '100%' }}
                options={models.map(model => ({
                  value: model.name,
                  label: model.name,
                }))}
                loading={loadingModels}
              />
            )}
          </div>

          {/* MCP Config */}
          <div className="flex flex-col flex-grow">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center">
                <label className="block text-base font-medium text-text-primary">
                  {t('bot.mcp_config')}
                </label>
              </div>
              <Button size="small" onClick={() => handleImportMcpConfig()} className="text-xs">
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
        </div>

        {/* Right Prompt area - responsive layout */}
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
      </div>

      {/* MCP Configuration Import Modal */}
      <McpConfigImportModal
        visible={importModalVisible}
        onClose={() => setImportModalVisible(false)}
        onImport={handleImportConfirm}
        message={message}
        agentType={agentName as 'ClaudeCode' | 'Agno'}
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
