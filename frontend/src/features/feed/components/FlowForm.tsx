'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Flow creation/edit form component.
 */
import { useCallback, useEffect, useState } from 'react'
import { Copy, Check, Terminal } from 'lucide-react'
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
import type { Team, GitRepoInfo, GitBranch } from '@/types/api'
import type {
  Flow,
  FlowCreateRequest,
  FlowTaskType,
  FlowTriggerType,
  FlowUpdateRequest,
} from '@/types/flow'
import { toast } from 'sonner'
import { CronSchedulePicker } from './CronSchedulePicker'
import { RepositorySelector, BranchSelector } from '@/features/tasks/components/selector'
import { parseUTCDate } from '@/lib/utils'

/**
 * Webhook API Usage Section Component
 * Shows API endpoint, secret, and example curl command for webhook-type flows
 */
function WebhookApiSection({ flow }: { flow: Flow }) {
  const { t } = useTranslation('feed')
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const fullWebhookUrl = `${baseUrl}${flow.webhook_url}`

  const handleCopy = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  // Generate curl example
  const curlExample = flow.webhook_secret
    ? `# ${t('webhook_with_signature')}
secret="${flow.webhook_secret}"
BODY='{"key": "value"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$secret" | cut -d' ' -f2)

curl -X POST "${fullWebhookUrl}" \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Signature: sha256=$SIGNATURE" \\
  -d "$BODY"`
    : `# ${t('webhook_without_signature')}
curl -X POST "${fullWebhookUrl}" \\
  -H "Content-Type: application/json" \\
  -d '{"key": "value"}'`

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/30 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
          {t('webhook_api_usage')}
        </span>
      </div>

      {/* Webhook URL */}
      <div className="space-y-1.5">
        <Label className="text-xs text-text-muted">{t('webhook_endpoint')}</Label>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-background px-3 py-2 rounded border border-border font-mono truncate">
            {fullWebhookUrl}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => handleCopy(fullWebhookUrl, 'url')}
          >
            {copiedField === 'url' ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Webhook secret */}
      {flow.webhook_secret && (
        <div className="space-y-1.5">
          <Label className="text-xs text-text-muted">{t('webhook_secret_label')}</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-background px-3 py-2 rounded border border-border font-mono truncate">
              {flow.webhook_secret}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => handleCopy(flow.webhook_secret!, 'secret')}
            >
              {copiedField === 'secret' ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="text-xs text-text-muted">{t('webhook_secret_hint')}</p>
        </div>
      )}

      {/* Curl Example */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-text-muted">{t('webhook_curl_example')}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => handleCopy(curlExample, 'curl')}
          >
            {copiedField === 'curl' ? (
              <>
                <Check className="h-3 w-3 mr-1 text-green-500" />
                {t('common:actions.copied')}
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 mr-1" />
                {t('common:actions.copy')}
              </>
            )}
          </Button>
        </div>
        <pre className="text-xs bg-background p-3 rounded border border-border font-mono overflow-x-auto whitespace-pre">
          {curlExample}
        </pre>
      </div>

      {/* Payload hint */}
      <p className="text-xs text-text-muted">{t('webhook_payload_hint')}</p>
    </div>
  )
}

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
  const { t } = useTranslation('feed')
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

  // Repository/Branch state for code-type teams
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

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

  // Get selected team
  const selectedTeam = teams.find(t => t.id === teamId)

  // Check if selected team is code-type (needs repository selection)
  const isCodeTypeTeam =
    selectedTeam?.recommended_mode === 'code' || selectedTeam?.recommended_mode === 'both'

  // Debug log
  console.log(
    '[FlowForm] selectedTeam:',
    selectedTeam?.name,
    'recommended_mode:',
    selectedTeam?.recommended_mode,
    'isCodeTypeTeam:',
    isCodeTypeTeam
  )

  // Handle repository change
  const handleRepoChange = useCallback((repo: GitRepoInfo | null) => {
    setSelectedRepo(repo)
    setSelectedBranch(null) // Reset branch when repo changes
  }, [])

  // Handle branch change
  const handleBranchChange = useCallback((branch: GitBranch | null) => {
    setSelectedBranch(branch)
  }, [])

  // Handle team change - reset repo/branch when team changes
  const handleTeamChange = useCallback((value: string) => {
    const newTeamId = parseInt(value)
    setTeamId(newTeamId)
    // Reset repository selection when team changes
    setSelectedRepo(null)
    setSelectedBranch(null)
  }, [])

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
      // Note: workspace_id restoration will be handled when we have workspace API
      // For now, reset repo selection
      setSelectedRepo(null)
      setSelectedBranch(null)
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
      setSelectedRepo(null)
      setSelectedBranch(null)
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
          // Include git repo info if selected
          ...(selectedRepo && {
            git_repo: selectedRepo.git_repo,
            git_repo_id: selectedRepo.git_repo_id,
            git_domain: selectedRepo.git_domain,
            branch_name: selectedBranch?.name || 'main',
          }),
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
          // Include git repo info if selected
          ...(selectedRepo && {
            git_repo: selectedRepo.git_repo,
            git_repo_id: selectedRepo.git_repo_id,
            git_domain: selectedRepo.git_domain,
            branch_name: selectedBranch?.name || 'main',
          }),
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
    selectedRepo,
    selectedBranch,
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
        // Convert UTC ISO string to local datetime-local format (YYYY-MM-DDTHH:mm)
        const getLocalDateTimeValue = (isoString: string | undefined): string => {
          if (!isoString) return ''
          // Use parseUTCDate to correctly parse UTC time from backend
          const date = parseUTCDate(isoString)
          if (!date || isNaN(date.getTime())) return ''
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
                  // Convert local datetime-local value to UTC ISO string
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
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="pb-4 border-b border-border">
          <DialogTitle className="text-xl">
            {isEditing ? t('edit_subscription') : t('create_subscription')}
          </DialogTitle>
          <DialogDescription>
            {isEditing ? t('edit_subscription_desc') : t('create_subscription_desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-6 px-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 px-1">
            {/* Left Column - Basic Info */}
            <div className="space-y-5">
              <div className="pb-2 border-b border-border/50">
                <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                  {t('basic_info') || '基本信息'}
                </h3>
              </div>

              {/* Display Name */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {t('display_name')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder={t('display_name_placeholder')}
                  className="h-10"
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('description')}</Label>
                <Input
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t('description_placeholder')}
                  className="h-10"
                />
              </div>

              {/* Task Type */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {t('task_type')} <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={taskType}
                  onValueChange={value => setTaskType(value as FlowTaskType)}
                >
                  <SelectTrigger className="h-10">
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

              {/* Team Selection */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {t('select_team')} <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={teamId?.toString() || ''}
                  onValueChange={handleTeamChange}
                  disabled={teamsLoading}
                >
                  <SelectTrigger className="h-10">
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

              {/* Repository Selection - Only show for code-type teams */}
              {isCodeTypeTeam && (
                <div className="space-y-3 rounded-lg border border-border bg-background-secondary/30 p-4">
                  <div className="text-sm font-medium text-text-secondary">
                    {t('workspace_settings')}
                  </div>

                  {/* Repository Selection */}
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

                  {/* Branch Selection - Only show when repository is selected */}
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

              {/* Enabled */}
              <div className="flex items-center justify-between pt-2">
                <Label className="text-sm font-medium">{t('enable_subscription')}</Label>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>

            {/* Right Column - Trigger & Execution */}
            <div className="space-y-5">
              <div className="pb-2 border-b border-border/50">
                <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                  {t('trigger_settings') || '触发设置'}
                </h3>
              </div>

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
              <div className="rounded-lg border border-border bg-background-secondary/30 p-4">
                <div className="mb-3 text-sm font-medium text-text-secondary">
                  {t('trigger_config')}
                </div>
                {renderTriggerConfig()}
              </div>

              {/* Webhook API Usage - Only show for event trigger with webhook when editing */}
              {isEditing &&
                flow &&
                triggerType === 'event' &&
                triggerConfig.event_type === 'webhook' &&
                flow.webhook_url && <WebhookApiSection flow={flow} />}

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
            </div>
          </div>

          {/* Full Width - Prompt Template */}
          <div className="mt-6 pt-6 border-t border-border/50">
            <div className="pb-3">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                {t('prompt_config') || 'Prompt 配置'}
              </h3>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                {t('prompt_template')} <span className="text-destructive">*</span>
              </Label>
              <Textarea
                value={promptTemplate}
                onChange={e => setPromptTemplate(e.target.value)}
                placeholder={t('prompt_template_placeholder')}
                rows={5}
                className="resize-none"
              />
              <p className="text-xs text-text-muted">{t('prompt_variables_hint')}</p>
            </div>
          </div>
        </div>

        <DialogFooter className="pt-4 border-t border-border gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="min-w-[100px]"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting} className="min-w-[100px]">
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
