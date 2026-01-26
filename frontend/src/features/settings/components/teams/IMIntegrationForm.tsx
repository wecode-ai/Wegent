// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useTranslation } from '@/hooks/useTranslation'
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle, Trash2 } from 'lucide-react'
import { FaTelegram } from 'react-icons/fa'
import { IMIntegrationConfig, IMPlatform } from '@/types/api'

interface IMIntegrationFormProps {
  integrations: IMIntegrationConfig[]
  setIntegrations: (integrations: IMIntegrationConfig[]) => void
  onValidate?: (provider: IMPlatform, config: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    bot_info?: { username?: string }
  }>
}

// Platform configuration
const PLATFORM_CONFIG: Record<IMPlatform, {
  name: string
  icon: React.ReactNode
  fields: { name: string; label: string; type: 'text' | 'password'; placeholder: string }[]
  available: boolean
}> = {
  telegram: {
    name: 'Telegram',
    icon: <FaTelegram className="h-5 w-5 text-[#0088cc]" />,
    fields: [
      {
        name: 'token',
        label: 'Bot Token',
        type: 'password',
        placeholder: 'Enter your Telegram bot token from @BotFather',
      },
    ],
    available: true,
  },
  slack: {
    name: 'Slack',
    icon: <span className="text-lg">📱</span>,
    fields: [
      { name: 'bot_token', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...' },
      { name: 'app_token', label: 'App Token', type: 'password', placeholder: 'xapp-...' },
    ],
    available: false,
  },
  discord: {
    name: 'Discord',
    icon: <span className="text-lg">🎮</span>,
    fields: [
      { name: 'token', label: 'Bot Token', type: 'password', placeholder: 'Enter Discord bot token' },
    ],
    available: false,
  },
  feishu: {
    name: 'Feishu',
    icon: <span className="text-lg">🐦</span>,
    fields: [
      { name: 'app_id', label: 'App ID', type: 'text', placeholder: 'cli_xxx' },
      { name: 'app_secret', label: 'App Secret', type: 'password', placeholder: 'Enter app secret' },
    ],
    available: false,
  },
  dingtalk: {
    name: 'DingTalk',
    icon: <span className="text-lg">💬</span>,
    fields: [],
    available: false,
  },
  wechat: {
    name: 'WeChat',
    icon: <span className="text-lg">💚</span>,
    fields: [],
    available: false,
  },
}

interface IntegrationItemProps {
  integration: IMIntegrationConfig
  onUpdate: (integration: IMIntegrationConfig) => void
  onRemove: () => void
  onValidate?: IMIntegrationFormProps['onValidate']
}

function IntegrationItem({ integration, onUpdate, onRemove, onValidate }: IntegrationItemProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    error?: string
    botUsername?: string
  } | null>(null)

  const platformConfig = PLATFORM_CONFIG[integration.provider]

  const handleValidate = async () => {
    if (!onValidate) return

    setValidating(true)
    setValidationResult(null)

    try {
      const result = await onValidate(integration.provider, integration.config)
      setValidationResult({
        valid: result.valid,
        error: result.error,
        botUsername: result.bot_info?.username,
      })
    } catch (error) {
      setValidationResult({
        valid: false,
        error: (error as Error).message,
      })
    } finally {
      setValidating(false)
    }
  }

  const handleConfigChange = (fieldName: string, value: string) => {
    onUpdate({
      ...integration,
      config: {
        ...integration.config,
        [fieldName]: value,
      },
    })
    // Clear validation result when config changes
    setValidationResult(null)
  }

  const handleEnabledChange = (enabled: boolean) => {
    onUpdate({
      ...integration,
      enabled,
    })
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="border border-border rounded-lg">
        <CollapsibleTrigger asChild>
          <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-accent/50 transition-colors">
            <div className="flex items-center gap-3">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-text-muted" />
              ) : (
                <ChevronRight className="h-4 w-4 text-text-muted" />
              )}
              {platformConfig.icon}
              <span className="font-medium">{platformConfig.name}</span>
              {validationResult?.valid && validationResult.botUsername && (
                <span className="text-xs text-text-muted">@{validationResult.botUsername}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {validationResult !== null && (
                validationResult.valid ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" />
                )
              )}
              <Switch
                checked={integration.enabled}
                onCheckedChange={handleEnabledChange}
                onClick={e => e.stopPropagation()}
              />
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 pt-0 space-y-3 border-t border-border">
            {platformConfig.fields.map(field => (
              <div key={field.name} className="space-y-1.5 pt-3">
                <Label className="text-sm">{field.label}</Label>
                <Input
                  type={field.type}
                  value={integration.config[field.name] || ''}
                  onChange={e => handleConfigChange(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  className="bg-base"
                />
              </div>
            ))}

            {validationResult?.error && (
              <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-2 rounded">
                {validationResult.error}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRemove}
                className="text-red-500 hover:text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {t('common:actions.remove')}
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleValidate}
                disabled={validating || !platformConfig.fields.every(f => integration.config[f.name])}
              >
                {validating && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                {t('common:im.validate_config')}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export default function IMIntegrationForm({
  integrations,
  setIntegrations,
  onValidate,
}: IMIntegrationFormProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)

  // Get available platforms that haven't been added yet
  const availablePlatforms = (Object.keys(PLATFORM_CONFIG) as IMPlatform[]).filter(
    platform => PLATFORM_CONFIG[platform].available && !integrations.some(i => i.provider === platform)
  )

  const handleAddPlatform = (platform: IMPlatform) => {
    const newIntegration: IMIntegrationConfig = {
      provider: platform,
      enabled: false,
      config: {},
    }
    setIntegrations([...integrations, newIntegration])
  }

  const handleUpdateIntegration = (index: number, integration: IMIntegrationConfig) => {
    const updated = [...integrations]
    updated[index] = integration
    setIntegrations(updated)
  }

  const handleRemoveIntegration = (index: number) => {
    setIntegrations(integrations.filter((_, i) => i !== index))
  }

  // Don't show the section if no platforms are available
  const hasAvailablePlatforms = Object.values(PLATFORM_CONFIG).some(p => p.available)
  if (!hasAvailablePlatforms) return null

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="border border-border rounded-lg">
        <CollapsibleTrigger asChild>
          <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-accent/50 transition-colors">
            <div className="flex items-center gap-2">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-text-muted" />
              ) : (
                <ChevronRight className="h-4 w-4 text-text-muted" />
              )}
              <span className="font-medium">{t('common:im.title')}</span>
              {integrations.length > 0 && (
                <span className="text-xs text-text-muted bg-accent px-1.5 py-0.5 rounded">
                  {integrations.filter(i => i.enabled).length}/{integrations.length}
                </span>
              )}
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 pt-0 space-y-3 border-t border-border">
            <p className="text-sm text-text-muted pt-3">
              {t('common:im.description')}
            </p>

            {/* Existing integrations */}
            {integrations.map((integration, index) => (
              <IntegrationItem
                key={integration.provider}
                integration={integration}
                onUpdate={updated => handleUpdateIntegration(index, updated)}
                onRemove={() => handleRemoveIntegration(index)}
                onValidate={onValidate}
              />
            ))}

            {/* Add new platform */}
            {availablePlatforms.length > 0 && (
              <div className="pt-2">
                <Label className="text-sm text-text-muted mb-2 block">
                  {t('common:im.add_platform')}
                </Label>
                <div className="flex flex-wrap gap-2">
                  {availablePlatforms.map(platform => (
                    <Button
                      key={platform}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleAddPlatform(platform)}
                      className="flex items-center gap-2"
                    >
                      {PLATFORM_CONFIG[platform].icon}
                      {PLATFORM_CONFIG[platform].name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
