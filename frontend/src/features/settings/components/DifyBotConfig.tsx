// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiClient } from '@/apis/client'
import { InformationCircleIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

interface DifyBotConfigProps {
  agentConfig: string
  onAgentConfigChange: (config: string) => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  /** Whether the component is in read-only mode */
  readOnly?: boolean
}

interface DifyAppInfo {
  name: string
  description?: string
  mode?: string
  icon?: string
  icon_background?: string
  user_input_form?: Array<{
    variable: string
    label: Record<string, string>
    required: boolean
    type: string
    options?: string[]
  }>
}

const DifyBotConfig: React.FC<DifyBotConfigProps> = ({
  agentConfig,
  onAgentConfigChange,
  toast,
  readOnly = false,
}) => {
  const { t } = useTranslation()
  const [difyApiKey, setDifyApiKey] = useState<string>('')
  const [difyBaseUrl, setDifyBaseUrl] = useState<string>('https://api.dify.ai')
  const [isValidating, setIsValidating] = useState(false)
  const [appInfo, setAppInfo] = useState<DifyAppInfo | null>(null)
  const [isValidated, setIsValidated] = useState(false)
  const [difyParams, setDifyParams] = useState<Record<string, string>>({})

  // Parse existing agent_config to extract Dify settings
  useEffect(() => {
    if (!agentConfig.trim()) {
      return
    }

    try {
      const config = JSON.parse(agentConfig)
      const env = config.env || {}

      // Extract Dify API credentials
      setDifyApiKey(env.DIFY_API_KEY || '')
      setDifyBaseUrl(env.DIFY_BASE_URL || 'https://api.dify.ai')

      // Extract Dify parameters if exists
      if (env.DIFY_PARAMS) {
        try {
          const params =
            typeof env.DIFY_PARAMS === 'string' ? JSON.parse(env.DIFY_PARAMS) : env.DIFY_PARAMS
          setDifyParams(params)
        } catch (e) {
          console.error('Failed to parse DIFY_PARAMS:', e)
        }
      }
    } catch (error) {
      console.error('Failed to parse agent config:', error)
    }
  }, [agentConfig])

  // Validate Dify API key by fetching app info and parameters
  const validateApiKey = useCallback(async () => {
    if (!difyApiKey || !difyBaseUrl) {
      toast({
        variant: 'destructive',
        title:
          t('common:bot.dify_api_key_required') || 'Please enter Dify API Key and Base URL first',
      })
      return
    }

    setIsValidating(true)
    setIsValidated(false)
    setAppInfo(null)

    try {
      // Fetch app info and parameters in parallel
      const [infoResponse, paramsResponse] = await Promise.all([
        apiClient.post<DifyAppInfo>('/dify/app/info', {
          api_key: difyApiKey,
          base_url: difyBaseUrl,
        }),
        apiClient
          .post<{ user_input_form?: DifyAppInfo['user_input_form'] }>('/dify/app/parameters', {
            api_key: difyApiKey,
            base_url: difyBaseUrl,
          })
          .catch(() => ({ user_input_form: [] })), // Fallback if parameters endpoint fails
      ])

      // Merge info and parameters
      const completeAppInfo: DifyAppInfo = {
        ...infoResponse,
        user_input_form: paramsResponse.user_input_form || infoResponse.user_input_form || [],
      }

      setAppInfo(completeAppInfo)
      setIsValidated(true)

      toast({
        title: t('common:bot.dify_validation_success') || 'API Key validated successfully',
        description: `Application: ${completeAppInfo.name}`,
      })
    } catch (error) {
      console.error('Failed to validate Dify API key:', error)
      toast({
        variant: 'destructive',
        title: t('common:bot.errors.dify_validation_failed') || 'Failed to validate API key',
        description: 'Please make sure your API key is valid and the base URL is correct.',
      })
      setIsValidated(false)
      setAppInfo(null)
    } finally {
      setIsValidating(false)
    }
  }, [difyApiKey, difyBaseUrl, toast, t])

  // Update agent_config whenever Dify settings change
  const updateAgentConfig = useCallback(() => {
    const config = {
      env: {
        DIFY_API_KEY: difyApiKey,
        DIFY_BASE_URL: difyBaseUrl,
        ...(appInfo?.mode && { DIFY_APP_MODE: appInfo.mode }),
        ...(Object.keys(difyParams).length > 0 && { DIFY_PARAMS: JSON.stringify(difyParams) }),
      },
    }

    onAgentConfigChange(JSON.stringify(config, null, 2))
  }, [difyApiKey, difyBaseUrl, appInfo, difyParams, onAgentConfigChange])

  useEffect(() => {
    updateAgentConfig()
  }, [updateAgentConfig])

  // Reset validation state when API key or base URL changes
  useEffect(() => {
    setIsValidated(false)
    setAppInfo(null)
  }, [difyApiKey, difyBaseUrl])

  const handleOpenDifyDocs = useCallback(() => {
    window.open('https://docs.dify.ai/guides/application-publishing/developing-with-apis', '_blank')
  }, [])

  return (
    <div className="flex flex-col space-y-4 w-full">
      {/* Info Banner */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <InformationCircleIcon className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-1">
              {t('common:bot.dify_mode_title') || 'Dify External API Mode'}
            </h4>
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
              {t('common:bot.dify_mode_description') ||
                'Dify bot delegates execution to external Dify API service. Enter your Dify application API key to get started.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenDifyDocs}
              className="text-xs h-7 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40"
            >
              📚 {t('common:bot.view_dify_docs') || 'View Dify API Documentation'}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Connection Configuration */}
        <div className="space-y-4">
          {/* Dify API Key */}
          <div className="flex flex-col">
            <Label htmlFor="dify-api-key" className="text-base font-medium text-text-primary mb-2">
              {t('common:bot.dify_api_key') || 'Dify API Key'}{' '}
              <span className="text-red-400">*</span>
            </Label>
            <input
              id="dify-api-key"
              type="password"
              value={difyApiKey}
              onChange={e => {
                if (readOnly) return
                setDifyApiKey(e.target.value)
              }}
              disabled={readOnly}
              placeholder="app-xxxxxxxxxxxxxxxxxxxxxxxx"
              className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base font-mono ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
            />
            <p className="text-xs text-text-muted mt-1">
              {t('common:bot.dify_api_key_hint') ||
                'Enter your Dify application API key. Each Dify application has its own API key.'}
            </p>
          </div>

          {/* Dify Base URL */}
          <div className="flex flex-col">
            <Label htmlFor="dify-base-url" className="text-base font-medium text-text-primary mb-2">
              {t('common:bot.dify_base_url') || 'Dify Base URL'}{' '}
              <span className="text-red-400">*</span>
            </Label>
            <input
              id="dify-base-url"
              type="url"
              value={difyBaseUrl}
              onChange={e => {
                if (readOnly) return
                setDifyBaseUrl(e.target.value)
              }}
              disabled={readOnly}
              placeholder="https://api.dify.ai"
              className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base font-mono ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
            />
            <p className="text-xs text-text-muted mt-1">
              {t('common:bot.dify_base_url_hint') ||
                'Dify API base URL. Use https://api.dify.ai for Dify Cloud, or your self-hosted URL.'}
            </p>
          </div>

          {/* Validation Button */}
          <Button
            size="default"
            onClick={validateApiKey}
            disabled={isValidating || !difyApiKey || !difyBaseUrl || readOnly}
            className="w-full"
          >
            {isValidating ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full mr-2" />
                {t('common:bot.validating') || 'Validating...'}
              </>
            ) : (
              <>✓ {t('common:bot.validate_api_key') || 'Validate API Key'}</>
            )}
          </Button>
        </div>

        {/* Right Column: Validation Result & Parameters */}
        <div className="space-y-4">
          {/* Validation Success Message */}
          {isValidated && appInfo && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <CheckCircleIcon className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium text-green-900 dark:text-green-100 mb-1">
                    {t('common:bot.validation_success') || 'API Key Validated Successfully'}
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

          {/* Dify Parameters Form (for apps with user_input_form) */}
          {isValidated &&
            appInfo &&
            appInfo.user_input_form &&
            appInfo.user_input_form.length > 0 && (
              <div className="flex flex-col">
                <Accordion type="single" collapsible defaultValue="params">
                  <AccordionItem value="params" className="border rounded-lg">
                    <AccordionTrigger className="px-4 py-3 hover:no-underline">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">
                          {t('common:bot.dify_app_parameters') || 'Application Parameters'}
                        </span>
                        <span className="text-xs text-text-muted">
                          ({appInfo.user_input_form.length}{' '}
                          {t('common:bot.dify_parameters_count') || 'parameters'})
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pb-4">
                      <div className="space-y-4">
                        <p className="text-xs text-text-muted mb-3">
                          {t('common:bot.dify_parameters_hint') ||
                            'Configure the input parameters for this Dify application. These values will be used when executing tasks.'}
                        </p>
                        {appInfo.user_input_form.map(field => (
                          <div key={field.variable} className="flex flex-col">
                            <Label
                              htmlFor={`param-${field.variable}`}
                              className="text-sm font-medium text-text-primary mb-1"
                            >
                              {field.label?.en || field.label?.['en-US'] || field.variable}
                              {field.required && <span className="text-red-400 ml-1">*</span>}
                            </Label>

                            {field.type === 'select' && field.options ? (
                              <select
                                id={`param-${field.variable}`}
                                value={difyParams[field.variable] || ''}
                                onChange={e => {
                                  if (readOnly) return
                                  setDifyParams({
                                    ...difyParams,
                                    [field.variable]: e.target.value,
                                  })
                                }}
                                disabled={readOnly}
                                className={`w-full px-3 py-2 bg-base rounded-md text-text-primary border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                              >
                                <option value="">Select...</option>
                                {field.options.map(option => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : field.type === 'text-input' || field.type === 'paragraph' ? (
                              <textarea
                                id={`param-${field.variable}`}
                                value={difyParams[field.variable] || ''}
                                onChange={e => {
                                  if (readOnly) return
                                  setDifyParams({
                                    ...difyParams,
                                    [field.variable]: e.target.value,
                                  })
                                }}
                                disabled={readOnly}
                                placeholder={field.label?.en || field.label?.['en-US'] || ''}
                                rows={field.type === 'paragraph' ? 4 : 2}
                                className={`w-full px-3 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm resize-none ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                              />
                            ) : (
                              <input
                                id={`param-${field.variable}`}
                                type="text"
                                value={difyParams[field.variable] || ''}
                                onChange={e => {
                                  if (readOnly) return
                                  setDifyParams({
                                    ...difyParams,
                                    [field.variable]: e.target.value,
                                  })
                                }}
                                disabled={readOnly}
                                placeholder={field.label?.en || field.label?.['en-US'] || ''}
                                className={`w-full px-3 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            )}

          {/* Preview Configuration */}
          <div className="flex flex-col">
            <Label className="text-sm font-medium text-text-muted mb-2">
              {t('common:bot.config_preview') || 'Configuration Preview'}
            </Label>
            <Textarea
              value={agentConfig}
              readOnly
              className="w-full px-4 py-2 bg-base-secondary rounded-md text-text-muted font-mono text-xs min-h-[120px] cursor-not-allowed"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default DifyBotConfig
