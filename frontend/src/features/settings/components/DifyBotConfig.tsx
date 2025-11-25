// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/apis/client';
import { InformationCircleIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';

interface DifyBotConfigProps {
  agentConfig: string;
  onAgentConfigChange: (config: string) => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

interface DifyAppInfo {
  name: string;
  description?: string;
  mode?: string;
  icon?: string;
  icon_background?: string;
}

const DifyBotConfig: React.FC<DifyBotConfigProps> = ({
  agentConfig,
  onAgentConfigChange,
  toast,
}) => {
  const { t } = useTranslation('common');
  const [difyApiKey, setDifyApiKey] = useState<string>('');
  const [difyBaseUrl, setDifyBaseUrl] = useState<string>('https://api.dify.ai');
  const [isValidating, setIsValidating] = useState(false);
  const [appInfo, setAppInfo] = useState<DifyAppInfo | null>(null);
  const [isValidated, setIsValidated] = useState(false);

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
    } catch (error) {
      console.error('Failed to parse agent config:', error);
    }
  }, [agentConfig]);

  // Validate Dify API key by fetching app info
  const validateApiKey = useCallback(async () => {
    if (!difyApiKey || !difyBaseUrl) {
      toast({
        variant: 'destructive',
        title: t('bot.dify_api_key_required') || 'Please enter Dify API Key and Base URL first',
      });
      return;
    }

    setIsValidating(true);
    setIsValidated(false);
    setAppInfo(null);

    try {
      const response = await apiClient.post<DifyAppInfo>('/dify/app/info', {
        api_key: difyApiKey,
        base_url: difyBaseUrl,
      });

      setAppInfo(response);
      setIsValidated(true);

      toast({
        title: t('bot.dify_validation_success') || 'API Key validated successfully',
        description: `Application: ${response.name}`,
      });
    } catch (error) {
      console.error('Failed to validate Dify API key:', error);
      toast({
        variant: 'destructive',
        title: t('bot.errors.dify_validation_failed') || 'Failed to validate API key',
        description:
          'Please make sure your API key is valid and the base URL is correct.',
      });
      setIsValidated(false);
      setAppInfo(null);
    } finally {
      setIsValidating(false);
    }
  }, [difyApiKey, difyBaseUrl, toast, t]);

  // Update agent_config whenever Dify settings change
  const updateAgentConfig = useCallback(() => {
    const config = {
      env: {
        DIFY_API_KEY: difyApiKey,
        DIFY_BASE_URL: difyBaseUrl,
      },
    };

    onAgentConfigChange(JSON.stringify(config, null, 2));
  }, [difyApiKey, difyBaseUrl, onAgentConfigChange]);

  useEffect(() => {
    updateAgentConfig();
  }, [updateAgentConfig]);

  // Reset validation state when API key or base URL changes
  useEffect(() => {
    setIsValidated(false);
    setAppInfo(null);
  }, [difyApiKey, difyBaseUrl]);

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
                'Dify bot delegates execution to external Dify API service. Enter your Dify application API key to get started.'}
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
            'Enter your Dify application API key. Each Dify application has its own API key.'}
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

      {/* Validation Button and Result */}
      <div className="flex flex-col">
        <Button
          size="default"
          onClick={validateApiKey}
          disabled={isValidating || !difyApiKey || !difyBaseUrl}
          className="w-full"
        >
          {isValidating ? (
            <>
              <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full mr-2" />
              {t('bot.validating') || 'Validating...'}
            </>
          ) : (
            <>✓ {t('bot.validate_api_key') || 'Validate API Key'}</>
          )}
        </Button>

        {/* Validation Success Message */}
        {isValidated && appInfo && (
          <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <CheckCircleIcon className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium text-green-900 dark:text-green-100 mb-1">
                  {t('bot.validation_success') || 'API Key Validated Successfully'}
                </h4>
                <div className="text-xs text-green-700 dark:text-green-300 space-y-1">
                  <p>
                    <span className="font-medium">Application:</span> {appInfo.name}
                  </p>
                  {appInfo.mode && (
                    <p>
                      <span className="font-medium">Mode:</span>{' '}
                      <span className="capitalize">{appInfo.mode}</span>
                    </p>
                  )}
                  {appInfo.description && (
                    <p>
                      <span className="font-medium">Description:</span> {appInfo.description}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
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
