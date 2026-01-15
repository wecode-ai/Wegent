'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Flow creation/edit form component.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { flowApis } from '@/apis/flow'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import type {
  Flow,
  FlowCreateRequest,
  FlowTaskType,
  FlowTriggerType,
  FlowUpdateRequest,
} from '@/types/flow'
import { toast } from 'sonner'
import { CronSchedulePicker } from './CronSchedulePicker'

interface FlowFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  flow?: Flow | null
  onSuccess: () => void
}

// Get user's local timezone (e.g., 'Asia/Shanghai', 'America/New_York')
const getUserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

const defaultTriggerConfig: Record<FlowTriggerType, Record<string, unknown>> = {
  cron: { expression: '0 9 * * *', timezone: getUserTimezone() },
  interval: { value: 1, unit: 'hours' },
  one_time: { execute_at: new Date().toISOString() },
  event: { event_type: 'webhook' },
}

export function FlowForm({ open, onOpenChange, flow, onSuccess }: FlowFormProps) {
  const { t } = useTranslation('flow')
  const isEditing = !!flow

  // Form state
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [taskType, setTaskType] = useState<FlowTaskType>('collection')
  const [triggerType, setTriggerType] = useState<FlowTriggerType>('cron')
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(
    defaultTriggerConfig.cron
  )
  const [teamId, setTeamId] = useState<number | null>(null)
  const [promptTemplate, setPromptTemplate] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [timeoutSeconds, setTimeoutSeconds] = useState(600) // Default 10 minutes
  const [enabled, setEnabled] = useState(true)

  // Teams for selection
  const [teams, setTeams] = useState<Team[]>([])
  const [teamsLoading, setTeamsLoading] = useState(false)

  // Submit state
  const [submitting, setSubmitting] = useState(false)

  // Load teams
  useEffect(() => {
    const loadTeams = async () => {
      setTeamsLoading(true)
      try {
        const response = await teamApis.getTeams({ page: 1, limit: 100 })
        setTeams(response.items)
      } catch (error) {
        console.error('Failed to load teams:', error)
      } finally {
        setTeamsLoading(false)
      }
    }
    if (open) {
      loadTeams()
    }
  }, [open])

  // Reset form when flow changes
  useEffect(() => {
    if (flow) {
      setDisplayName(flow.display_name)
      setDescription(flow.description || '')
      setTaskType(flow.task_type)
      setTriggerType(flow.trigger_type)
      setTriggerConfig(flow.trigger_config)
      setTeamId(flow.team_id)
      setPromptTemplate(flow.prompt_template)
      setRetryCount(flow.retry_count)
      setTimeoutSeconds(flow.timeout_seconds || 600)
      setEnabled(flow.enabled)
    } else {
      setDisplayName('')
      setDescription('')
      setTaskType('collection')
      setTriggerType('cron')
      setTriggerConfig(defaultTriggerConfig.cron)
      setTeamId(null)
      setPromptTemplate('')
      setRetryCount(0)
      setTimeoutSeconds(600)
      setEnabled(true)
    }
  }, [flow, open])

  // Handle trigger type change
  const handleTriggerTypeChange = useCallback((value: FlowTriggerType) => {
    setTriggerType(value)
    setTriggerConfig(defaultTriggerConfig[value])
  }, [])

  // Handle submit
  const handleSubmit = useCallback(async () => {
    // Validation
    if (!displayName.trim()) {
      toast.error(t('validation_display_name_required'))
      return
    }
    if (!teamId) {
      toast.error(t('validation_team_required'))
      return
    }
    if (!promptTemplate.trim()) {
      toast.error(t('validation_prompt_required'))
      return
    }

    setSubmitting(true)
    try {
      if (isEditing && flow) {
        const updateData: FlowUpdateRequest = {
          display_name: displayName,
          description: description || undefined,
          task_type: taskType,
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          team_id: teamId,
          prompt_template: promptTemplate,
          retry_count: retryCount,
          timeout_seconds: timeoutSeconds,
          enabled,
        }
        await flowApis.updateFlow(flow.id, updateData)
        toast.success(t('update_success'))
      } else {
        // Generate name from display name
        const generatedName =
          displayName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50) || `flow-${Date.now()}`

        const createData: FlowCreateRequest = {
          name: generatedName,
          display_name: displayName,
          description: description || undefined,
          task_type: taskType,
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          team_id: teamId,
          prompt_template: promptTemplate,
          retry_count: retryCount,
          timeout_seconds: timeoutSeconds,
          enabled,
        }
        await flowApis.createFlow(createData)
        toast.success(t('create_success'))
      }
      onSuccess()
      onOpenChange(false)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : t('save_failed')
      console.error('Failed to save flow:', error)
      toast.error(errorMessage)
    } finally {
      setSubmitting(false)
    }
  }, [
    displayName,
    description,
    taskType,
    triggerType,
    triggerConfig,
    teamId,
    promptTemplate,
    retryCount,
    timeoutSeconds,
    enabled,
    isEditing,
    flow,
    onSuccess,
    onOpenChange,
    t,
  ])

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
      case 'interval':
        return (
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
              />
            </div>
            <div className="flex-1">
              <Label>{t('interval_unit')}</Label>
              <Select
                value={(triggerConfig.unit as string) || 'hours'}
                onValueChange={value => setTriggerConfig({ ...triggerConfig, unit: value })}
              >
                <SelectTrigger>
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
        )
      case 'one_time': {
        // Convert ISO string to local datetime-local format (YYYY-MM-DDTHH:mm)
        const getLocalDateTimeValue = (isoString: string | undefined): string => {
          if (!isoString) return ''
          const date = new Date(isoString)
          if (isNaN(date.getTime())) return ''
          // Format as local time for datetime-local input
          const year = date.getFullYear()
          const month = String(date.getMonth() + 1).padStart(2, '0')
          const day = String(date.getDate()).padStart(2, '0')
          const hours = String(date.getHours()).padStart(2, '0')
          const minutes = String(date.getMinutes()).padStart(2, '0')
          return `${year}-${month}-${day}T${hours}:${minutes}`
        }

        return (
          <div>
            <Label>{t('execute_at')}</Label>
            <Input
              type="datetime-local"
              value={getLocalDateTimeValue(triggerConfig.execute_at as string)}
              onChange={e => {
                if (e.target.value) {
                  setTriggerConfig({
                    ...triggerConfig,
                    execute_at: new Date(e.target.value).toISOString(),
                  })
                }
              }}
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('edit_flow') : t('create_flow')}</DialogTitle>
          <DialogDescription>
            {isEditing ? t('edit_flow_desc') : t('create_flow_desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-4">
          {/* Display Name */}
          <div>
            <Label>{t('display_name')} *</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={t('display_name_placeholder')}
            />
          </div>

          {/* Description */}
          <div>
            <Label>{t('description')}</Label>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('description_placeholder')}
            />
          </div>

          {/* Task Type */}
          <div>
            <Label>{t('task_type')} *</Label>
            <Select value={taskType} onValueChange={value => setTaskType(value as FlowTaskType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="collection">
                  {t('task_type_collection')} - {t('task_type_collection_desc')}
                </SelectItem>
                <SelectItem value="execution">
                  {t('task_type_execution')} - {t('task_type_execution_desc')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Trigger Type */}
          <div>
            <Label>{t('trigger_type')} *</Label>
            <Select value={triggerType} onValueChange={handleTriggerTypeChange}>
              <SelectTrigger>
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
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 text-sm font-medium">{t('trigger_config')}</div>
            {renderTriggerConfig()}
          </div>

          {/* Team Selection */}
          <div>
            <Label>{t('select_team')} *</Label>
            <Select
              value={teamId?.toString() || ''}
              onValueChange={value => setTeamId(parseInt(value))}
              disabled={teamsLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('select_team_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {teams.map(team => (
                  <SelectItem key={team.id} value={team.id.toString()}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Prompt Template */}
          <div>
            <Label>{t('prompt_template')} *</Label>
            <Textarea
              value={promptTemplate}
              onChange={e => setPromptTemplate(e.target.value)}
              placeholder={t('prompt_template_placeholder')}
              rows={4}
            />
            <p className="mt-1 text-xs text-text-muted">{t('prompt_variables_hint')}</p>
          </div>

          {/* Retry Count */}
          <div>
            <Label>{t('retry_count')}</Label>
            <Select
              value={retryCount.toString()}
              onValueChange={value => setRetryCount(parseInt(value))}
            >
              <SelectTrigger>
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

          {/* Timeout */}
          <div>
            <Label>{t('timeout_seconds')}</Label>
            <Select
              value={timeoutSeconds.toString()}
              onValueChange={value => setTimeoutSeconds(parseInt(value))}
            >
              <SelectTrigger>
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
            <p className="mt-1 text-xs text-text-muted">{t('timeout_hint')}</p>
          </div>

          {/* Enabled */}
          <div className="flex items-center justify-between">
            <Label>{t('enable_flow')}</Label>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? t('common:actions.saving')
              : isEditing
                ? t('common:actions.save')
                : t('common:actions.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
