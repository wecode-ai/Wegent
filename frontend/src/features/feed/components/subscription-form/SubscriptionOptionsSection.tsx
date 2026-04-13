'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription Options Section - Trigger, Task Type, Repository
 */

import { useCallback } from 'react'
import { Clock, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CollapsibleSection } from '@/components/common/CollapsibleSection'
import type { GitRepoInfo, GitBranch } from '@/types/api'
import type { SubscriptionTriggerType } from '@/types/subscription'
import { CronSchedulePicker } from '../CronSchedulePicker'
import { RepositorySelector, BranchSelector } from '@/features/tasks/components/selector'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { parseUTCDate } from '@/lib/utils'
import type { SubscriptionOptionsSectionProps } from './types'

// Minimum interval in minutes
const MIN_INTERVAL_MINUTES = 15

/**
 * Validate interval trigger configuration
 * Returns error message if invalid, null if valid
 */
export function validateIntervalTrigger(
  triggerType: SubscriptionTriggerType,
  triggerConfig: Record<string, unknown>,
  t: (key: string) => string
): string | null {
  if (triggerType === 'interval') {
    const value = (triggerConfig.value as number) || 1
    const unit = (triggerConfig.unit as string) || 'hours'
    if (unit === 'minutes' && value < MIN_INTERVAL_MINUTES) {
      return t('interval_min_error').replace('{{min}}', String(MIN_INTERVAL_MINUTES))
    }
  }
  return null
}

// Get user's local timezone
const getUserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

const defaultTriggerConfig: Record<SubscriptionTriggerType, Record<string, unknown>> = {
  cron: { expression: '0 9 * * *', timezone: getUserTimezone() },
  interval: { value: 1, unit: 'hours' },
  one_time: { execute_at: new Date().toISOString() },
  event: { event_type: 'webhook' },
}

export function SubscriptionOptionsSection({
  triggerType,
  setTriggerType,
  triggerConfig,
  setTriggerConfig,
  isCodeTypeTeam,
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  retryCount,
  setRetryCount,
  timeoutSeconds,
  setTimeoutSeconds,
  expirationType,
  setExpirationType,
  expirationDate,
  setExpirationDate,
  durationDays,
  setDurationDays,
}: SubscriptionOptionsSectionProps) {
  const { t } = useTranslation('feed')

  const handleTriggerTypeChange = useCallback(
    (value: SubscriptionTriggerType) => {
      setTriggerType(value)
      setTriggerConfig(defaultTriggerConfig[value])
    },
    [setTriggerType, setTriggerConfig]
  )

  const handleRepoChange = useCallback(
    (repo: GitRepoInfo | null) => {
      setSelectedRepo(repo)
      setSelectedBranch(null)
    },
    [setSelectedRepo, setSelectedBranch]
  )

  const handleBranchChange = useCallback(
    (branch: GitBranch | null) => {
      setSelectedBranch(branch)
    },
    [setSelectedBranch]
  )

  const renderTriggerConfig = () => {
    switch (triggerType) {
      case 'cron':
        return (
          <div className="space-y-2">
            <CronSchedulePicker
              value={(triggerConfig.expression as string) || '0 9 * * *'}
              onChange={expression => setTriggerConfig({ ...triggerConfig, expression })}
            />
            <p className="text-xs text-text-muted">
              {t('timezone_hint')}: {(triggerConfig.timezone as string) || getUserTimezone()}
            </p>
          </div>
        )
      case 'interval': {
        const intervalError = validateIntervalTrigger(triggerType, triggerConfig, t)
        return (
          <div className="space-y-2">
            <div className="flex gap-3">
              <div className="flex-1">
                <Label>{t('interval_value')}</Label>
                <Input
                  type="number"
                  min={1}
                  value={(triggerConfig.value as number) || 1}
                  onChange={e =>
                    setTriggerConfig({
                      ...triggerConfig,
                      value: parseInt(e.target.value) || 1,
                    })
                  }
                  className={intervalError ? 'border-destructive' : ''}
                />
              </div>
              <div className="flex-1">
                <Label>{t('interval_unit')}</Label>
                <Select
                  value={(triggerConfig.unit as string) || 'hours'}
                  onValueChange={value => setTriggerConfig({ ...triggerConfig, unit: value })}
                >
                  <SelectTrigger className={intervalError ? 'border-destructive' : ''}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">{t('unit_minutes')}</SelectItem>
                    <SelectItem value="hours">{t('unit_hours')}</SelectItem>
                    <SelectItem value="days">{t('unit_days')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {intervalError && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                <span>{intervalError}</span>
              </div>
            )}
          </div>
        )
      }
      case 'one_time': {
        const getLocalDate = (isoString: string | undefined): Date | undefined => {
          if (!isoString) return undefined
          const date = parseUTCDate(isoString)
          if (!date || isNaN(date.getTime())) return undefined
          return date
        }

        const currentDate = getLocalDate(triggerConfig.execute_at as string)

        return (
          <div className="space-y-3">
            <Label>{t('execute_at')}</Label>
            <DateTimePicker
              value={currentDate}
              onChange={date => {
                if (date) {
                  setTriggerConfig({
                    ...triggerConfig,
                    execute_at: date.toISOString(),
                  })
                }
              }}
              placeholder={t('select_datetime')}
            />
          </div>
        )
      }
      case 'event':
        return (
          <div>
            <Label>{t('event_type')}</Label>
            <Select
              value={(triggerConfig.event_type as string) || 'webhook'}
              onValueChange={value => setTriggerConfig({ ...triggerConfig, event_type: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="webhook">Webhook</SelectItem>
                <SelectItem value="git_push">Git Push</SelectItem>
              </SelectContent>
            </Select>
            {triggerConfig.event_type === 'git_push' && (
              <div className="mt-3 space-y-3">
                <div>
                  <Label>{t('git_repository')}</Label>
                  <Input
                    value={
                      (
                        triggerConfig.git_push as
                          | { repository?: string; branch?: string }
                          | undefined
                      )?.repository || ''
                    }
                    onChange={e =>
                      setTriggerConfig({
                        ...triggerConfig,
                        git_push: {
                          ...(triggerConfig.git_push as
                            | { repository?: string; branch?: string }
                            | undefined),
                          repository: e.target.value,
                        },
                      })
                    }
                    placeholder="owner/repo"
                  />
                </div>
                <div>
                  <Label>{t('git_branch')}</Label>
                  <Input
                    value={
                      (
                        triggerConfig.git_push as
                          | { repository?: string; branch?: string }
                          | undefined
                      )?.branch || ''
                    }
                    onChange={e =>
                      setTriggerConfig({
                        ...triggerConfig,
                        git_push: {
                          ...(triggerConfig.git_push as
                            | { repository?: string; branch?: string }
                            | undefined),
                          branch: e.target.value,
                        },
                      })
                    }
                    placeholder="main"
                  />
                </div>
              </div>
            )}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <CollapsibleSection
      title={t('subscription_options') || '订阅选项'}
      icon={<Clock className="h-4 w-4 text-primary" />}
      defaultOpen={true}
    >
      {/* Trigger Type */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t('trigger_type')} <span className="text-destructive">*</span>
        </Label>
        <Select value={triggerType} onValueChange={handleTriggerTypeChange}>
          <SelectTrigger className="h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cron">{t('trigger_cron')}</SelectItem>
            <SelectItem value="interval">{t('trigger_interval')}</SelectItem>
            <SelectItem value="one_time">{t('trigger_one_time')}</SelectItem>
            <SelectItem value="event">{t('trigger_event')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Trigger Config */}
      <div className="rounded-lg border border-border bg-background p-4">
        <div className="mb-3 text-sm font-medium text-text-secondary">{t('trigger_config')}</div>
        {renderTriggerConfig()}
      </div>

      {/* Retry Count & Timeout in a row */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t('retry_count')}</Label>
          <Select
            value={retryCount.toString()}
            onValueChange={value => setRetryCount(parseInt(value))}
          >
            <SelectTrigger className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">0 ({t('no_retry')})</SelectItem>
              <SelectItem value="1">1</SelectItem>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">{t('timeout_seconds')}</Label>
          <Select
            value={timeoutSeconds.toString()}
            onValueChange={value => setTimeoutSeconds(parseInt(value))}
          >
            <SelectTrigger className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="60">1 {t('timeout_minute')}</SelectItem>
              <SelectItem value="120">2 {t('timeout_minutes')}</SelectItem>
              <SelectItem value="300">5 {t('timeout_minutes')}</SelectItem>
              <SelectItem value="600">
                10 {t('timeout_minutes')} ({t('default')})
              </SelectItem>
              <SelectItem value="900">15 {t('timeout_minutes')}</SelectItem>
              <SelectItem value="1800">30 {t('timeout_minutes')}</SelectItem>
              <SelectItem value="3600">60 {t('timeout_minutes')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-text-muted -mt-2">{t('timeout_hint')}</p>

      {/* Expiration Settings */}
      <div className="rounded-lg border border-border bg-background p-4">
        <div className="mb-3 text-sm font-medium text-text-secondary flex items-center gap-2">
          {t('expiration_settings') || 'Expiration Settings'}
        </div>
        <div className="space-y-4">
          {/* Expiration Type */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              {t('expiration_type') || 'Expiration Type'}
            </Label>
            <Select
              value={expirationType}
              onValueChange={value =>
                setExpirationType(value as 'none' | 'fixed_date' | 'duration_days')
              }
            >
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('expiration_none') || 'No Expiration'}</SelectItem>
                <SelectItem value="fixed_date">
                  {t('expiration_fixed_date') || 'Fixed Date'}
                </SelectItem>
                <SelectItem value="duration_days">
                  {t('expiration_duration_days') || 'Duration (Days)'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Fixed Date Picker */}
          {expirationType === 'fixed_date' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                {t('expiration_date') || 'Expiration Date'}
              </Label>
              <DateTimePicker
                value={expirationDate}
                onChange={setExpirationDate}
                placeholder={t('select_expiration_date') || 'Select expiration date and time'}
              />
            </div>
          )}

          {/* Duration Days Input */}
          {expirationType === 'duration_days' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t('duration_days') || 'Duration Days'}</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={durationDays}
                onChange={e => setDurationDays(parseInt(e.target.value) || 1)}
                placeholder={t('duration_days_placeholder') || 'Enter number of days'}
              />
              <p className="text-xs text-text-muted">
                {t('duration_days_hint') ||
                  'Subscription will expire after this many days from creation'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Repository Selection - Only show for code-type teams */}
      {isCodeTypeTeam && (
        <div className="space-y-3 rounded-lg border border-border bg-background p-4">
          <div className="text-sm font-medium text-text-secondary">{t('workspace_settings')}</div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('select_repository')}</Label>
            <div className="border border-border rounded-md px-2 py-1.5">
              <RepositorySelector
                selectedRepo={selectedRepo}
                handleRepoChange={handleRepoChange}
                disabled={false}
                fullWidth={true}
              />
            </div>
          </div>

          {selectedRepo && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t('select_branch')}</Label>
              <div className="border border-border rounded-md px-2 py-1.5">
                <BranchSelector
                  selectedRepo={selectedRepo}
                  selectedBranch={selectedBranch}
                  handleBranchChange={handleBranchChange}
                  disabled={false}
                />
              </div>
            </div>
          )}
          <p className="text-xs text-text-muted">{t('workspace_hint')}</p>
        </div>
      )}
    </CollapsibleSection>
  )
}
