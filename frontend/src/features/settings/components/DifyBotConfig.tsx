// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DifyApp } from '@/types/api';
import { apiClient } from '@/apis/client';
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select';
import { RocketLaunchIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';

interface DifyBotConfigProps {
  agentConfig: string;
  onAgentConfigChange: (config: string) => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

const DifyBotConfig: React.FC<DifyBotConfigProps> = ({
  agentConfig,
  onAgentConfigChange,
  toast,
}) => {
  const { t } = useTranslation('common');
  const [apps, setApps] = useState<DifyApp[]>([]);
  const [isLoadingApps, setIsLoadingApps] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [difyApiKey, setDifyApiKey] = useState<string>('');
  const [difyBaseUrl, setDifyBaseUrl] = useState<string>('https://api.dify.ai');

  // Parse existing agent_config to extract Dify settings
  useEffect(() => {
    if (!agentConfig.trim()) {
      return;
    }

    try {
      const config = JSON.parse(agentConfig);
      const env = config.env || {};

      // Extract Dify API credentials
      setDifyApiKey(env.DIFY_API_KEY || '');
      setDifyBaseUrl(env.DIFY_BASE_URL || 'https://api.dify.ai');

      // Extract bot_prompt data (this is typically stored in bot_prompt field, but we check here too)
      if (env.DIFY_APP_ID) {
        setSelectedAppId(env.DIFY_APP_ID);
      }
    } catch (error) {
      console.error('Failed to parse agent config:', error);
    }
  }, [agentConfig]);

  // Fetch Dify apps when API key is available
  useEffect(() => {
    if (!difyApiKey || !difyBaseUrl) {
      setApps([]);
      return;
    }

    const fetchApps = async () => {
      setIsLoadingApps(true);
      try {
        const response = await apiClient.get<DifyApp[]>('/dify/apps');
        setApps(response);

        // Auto-select first app if none selected
        if (!selectedAppId && response.length > 0) {
          setSelectedAppId(response[0].id);
        }
      } catch (error) {
        console.error('Failed to fetch Dify apps:', error);
        toast({
          variant: 'destructive',
          title: t('bot.errors.fetch_dify_apps_failed') || 'Failed to load Dify applications',
        });
        setApps([]);
      } finally {
        setIsLoadingApps(false);
      }
    };

    fetchApps();
  }, [difyApiKey, difyBaseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update agent_config whenever Dify settings change
  const updateAgentConfig = useCallback(() => {
    const config = {
      env: {
        DIFY_API_KEY: difyApiKey,
        DIFY_BASE_URL: difyBaseUrl,
        DIFY_APP_ID: selectedAppId,
      },
    };

    onAgentConfigChange(JSON.stringify(config, null, 2));
  }, [difyApiKey, difyBaseUrl, selectedAppId, onAgentConfigChange]);

  useEffect(() => {
    updateAgentConfig();
  }, [updateAgentConfig]);

  // Convert apps to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = apps.map(app => ({
    value: app.id,
    label: app.name,
    searchText: app.name,
    content: (
      <div className="flex items-center gap-2 min-w-0">
        {app.icon ? (
          <div
            className="w-6 h-6 flex-shrink-0 rounded flex items-center justify-center text-sm"
            style={{ backgroundColor: app.icon_background }}
          >
            {app.icon}
          </div>
        ) : (
          <RocketLaunchIcon className="w-4 h-4 flex-shrink-0 text-text-muted" />
        )}
        <span className="font-medium text-xs text-text-secondary truncate flex-1 min-w-0" title={app.name}>
          {app.name}
        </span>
        <span className="text-xs text-text-muted flex-shrink-0 capitalize">{app.mode}</span>
      </div>
    ),
  }));

  const handleOpenDifyDocs = useCallback(() => {
    window.open('https://docs.dify.ai/guides/application-publishing/developing-with-apis', '_blank');
  }, []);

  return (
    <div className="flex flex-col space-y-4 w-full">
      {/* Info Banner */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <InformationCircleIcon className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-1">
              {t('bot.dify_mode_title') || 'Dify External API Mode'}
            </h4>
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              {t('bot.dify_mode_description') ||
                'Dify bot delegates execution to external Dify API service. Configure your Dify API credentials and select an application.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenDifyDocs}
              className="text-xs h-7 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40"
            >
              📚 {t('bot.view_dify_docs') || 'View Dify API Documentation'}
            </Button>
          </div>
        </div>
      </div>

      {/* Dify API Key */}
      <div className="flex flex-col">
        <Label htmlFor="dify-api-key" className="text-base font-medium text-text-primary mb-2">
          {t('bot.dify_api_key') || 'Dify API Key'} <span className="text-red-400">*</span>
        </Label>
        <input
          id="dify-api-key"
          type="password"
          value={difyApiKey}
          onChange={e => setDifyApiKey(e.target.value)}
          placeholder="app-xxxxxxxxxxxxxxxxxxxxxxxx"
          className="w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base font-mono"
        />
        <p className="text-xs text-text-muted mt-1">
          {t('bot.dify_api_key_hint') ||
            'Enter your Dify API key. You can find it in your Dify application settings.'}
        </p>
      </div>

      {/* Dify Base URL */}
      <div className="flex flex-col">
        <Label htmlFor="dify-base-url" className="text-base font-medium text-text-primary mb-2">
          {t('bot.dify_base_url') || 'Dify Base URL'} <span className="text-red-400">*</span>
        </Label>
        <input
          id="dify-base-url"
          type="url"
          value={difyBaseUrl}
          onChange={e => setDifyBaseUrl(e.target.value)}
          placeholder="https://api.dify.ai"
          className="w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base font-mono"
        />
        <p className="text-xs text-text-muted mt-1">
          {t('bot.dify_base_url_hint') ||
            'Dify API base URL. Use https://api.dify.ai for Dify Cloud, or your self-hosted URL.'}
        </p>
      </div>

      {/* Dify Application Selector */}
      <div className="flex flex-col">
        <Label htmlFor="dify-app" className="text-base font-medium text-text-primary mb-2">
          {t('bot.dify_app') || 'Dify Application'}
        </Label>
        {isLoadingApps ? (
          <div className="flex items-center gap-2 text-sm text-text-muted py-2">
            <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
            <span>{t('bot.loading_apps') || 'Loading applications...'}</span>
          </div>
        ) : apps.length === 0 ? (
          <div className="text-sm text-text-muted py-2">
            {difyApiKey
              ? t('bot.no_apps_found') || 'No applications found. Please check your API key.'
              : t('bot.enter_api_key_first') || 'Please enter your Dify API key first.'}
          </div>
        ) : (
          <>
            <SearchableSelect
              value={selectedAppId}
              onValueChange={setSelectedAppId}
              disabled={isLoadingApps || apps.length === 0}
              placeholder={t('bot.select_dify_app') || 'Select Dify Application'}
              searchPlaceholder={t('bot.search_apps') || 'Search applications...'}
              items={selectItems}
              loading={isLoadingApps}
              emptyText={t('bot.no_apps_available') || 'No applications available'}
              noMatchText={t('bot.no_matching_apps') || 'No matching applications'}
              triggerClassName="w-full"
              contentClassName="max-w-md"
              renderTriggerValue={item => {
                if (!item) return null;
                const app = apps.find(a => a.id === item.value);
                return (
                  <div className="flex items-center gap-2 min-w-0">
                    {app?.icon ? (
                      <div
                        className="w-5 h-5 flex-shrink-0 rounded flex items-center justify-center text-xs"
                        style={{ backgroundColor: app.icon_background }}
                      >
                        {app.icon}
                      </div>
                    ) : (
                      <RocketLaunchIcon className="w-4 h-4 flex-shrink-0" />
                    )}
                    <span className="truncate max-w-full flex-1 min-w-0" title={item.label}>
                      {item.label}
                    </span>
                  </div>
                );
              }}
            />
            <p className="text-xs text-text-muted mt-1">
              {t('bot.dify_app_hint') ||
                'Select which Dify application to use. The application type and configuration will be used during task execution.'}
            </p>
          </>
        )}
      </div>

      {/* Preview Configuration */}
      <div className="flex flex-col">
        <Label className="text-sm font-medium text-text-muted mb-2">
          {t('bot.config_preview') || 'Configuration Preview'}
        </Label>
        <Textarea
          value={agentConfig}
          readOnly
          className="w-full px-4 py-2 bg-base-secondary rounded-md text-text-muted font-mono text-xs min-h-[120px] cursor-not-allowed"
        />
      </div>
    </div>
  );
};

export default DifyBotConfig;
