'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription creation/edit form component.
 * Refactored to use sub-components for better maintainability.
 */
import { useCallback, useEffect, useState } from 'react'
import { Copy, Check, Terminal, AlertTriangle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { deviceApis, type DeviceInfo } from '@/apis/devices'
import { subscriptionApis } from '@/apis/subscription'
import { teamApis } from '@/apis/team'
import { modelApis, UnifiedModel } from '@/apis/models'
import { userApis } from '@/apis/user'
import { fetchUnifiedSkillsList, type UnifiedSkill } from '@/apis/skills'
import type { Team, GitRepoInfo, GitBranch, SearchUser } from '@/types/api'
import type {
  NotificationChannelBindingConfig,
  NotificationChannelInfo,
  NotificationLevel,
  NotificationWebhook,
  Subscription,
  SubscriptionBindingUpdatePayload,
  SubscriptionCreateRequest,
  SubscriptionExecutionTarget,
  SubscriptionGroupInfoPayload,
  SubscriptionKnowledgeBaseRef,
  SubscriptionSkillRef,
  SubscriptionTaskType,
  SubscriptionTriggerType,
  SubscriptionUpdateRequest,
  SubscriptionVisibility,
} from '@/types/subscription'
import { toast } from 'sonner'
import { getCompatibleProviderFromAgentType } from '@/utils/modelCompatibility'
import { useSocket } from '@/contexts/SocketContext'
import {
  SendAreaSection,
  BasicInfoSection,
  SubscriptionOptionsSection,
  NotificationSection,
  type SubscriptionModel,
  validateIntervalTrigger,
} from './subscription-form'

const resolveGitType = (gitDomain?: string): GitRepoInfo['type'] => {
  if (!gitDomain) return 'github'
  if (gitDomain.includes('gitlab')) return 'gitlab'
  if (gitDomain.includes('gitee')) return 'gitee'
  if (gitDomain.endsWith('github.com')) return 'github'
  return 'github'
}

const buildRepoInfoFromSubscription = (subscription: Subscription): GitRepoInfo | null => {
  if (!subscription.git_repo) return null
  const gitDomain = subscription.git_domain || 'github.com'
  const repoName = subscription.git_repo.split('/').pop() || subscription.git_repo

  return {
    git_repo_id: subscription.git_repo_id ?? 0,
    name: repoName,
    git_repo: subscription.git_repo,
    git_url: `https://${gitDomain}/${subscription.git_repo}.git`,
    git_domain: gitDomain,
    private: false,
    type: resolveGitType(gitDomain),
  }
}

/**
 * Webhook API Usage Section Component
 * Shows API endpoint, secret, and example curl command for webhook-type subscriptions
 */
function WebhookApiSection({ subscription }: { subscription: Subscription }) {
  const { t } = useTranslation('feed')
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const fullWebhookUrl = `${baseUrl}${subscription.webhook_url}`

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
  const curlExample = subscription.webhook_secret
    ? `# ${t('webhook_with_signature')}
SECRET="${subscription.webhook_secret}"
BODY='{"key": "value"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

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

      {/* Webhook Secret */}
      {subscription.webhook_secret && (
        <div className="space-y-1.5">
          <Label className="text-xs text-text-muted">{t('webhook_secret_label')}</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-background px-3 py-2 rounded border border-border font-mono truncate">
              {subscription.webhook_secret}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => handleCopy(subscription.webhook_secret!, 'secret')}
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

interface SubscriptionFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subscription?: Subscription | null
  onSuccess: () => void
  /** Initial form data for prefilling (from scheme URL or other sources) */
  initialData?: Partial<{
    displayName: string
    description: string
    taskType: SubscriptionTaskType
    triggerType: SubscriptionTriggerType
    triggerConfig: Record<string, unknown>
    promptTemplate: string
    retryCount: number
    timeoutSeconds: number
    enabled: boolean
    preserveHistory: boolean
    visibility: SubscriptionVisibility
    executionTarget: SubscriptionExecutionTarget
  }>
}

// Get user's local timezone (e.g., 'Asia/Shanghai', 'America/New_York')
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

const normalizeExecutionTarget = (
  target?: Partial<SubscriptionExecutionTarget>
): SubscriptionExecutionTarget => ({
  type: target?.type || 'managed',
  ...(target?.device_id ? { device_id: target.device_id } : {}),
})

const sortDevicesForSelection = (devices: DeviceInfo[]): DeviceInfo[] =>
  [...devices].sort((left, right) => {
    if (left.device_type !== right.device_type) {
      return left.device_type === 'local' ? -1 : 1
    }
    if (left.is_default !== right.is_default) {
      return left.is_default ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })

const getPreferredDevice = (devices: DeviceInfo[]): DeviceInfo | null => {
  const sortedDevices = sortDevicesForSelection(devices)
  return sortedDevices[0] || null
}

export function SubscriptionForm({
  open,
  onOpenChange,
  subscription,
  onSuccess,
  initialData,
}: SubscriptionFormProps) {
  const { t } = useTranslation('feed')
  const { socket } = useSocket()
  const isEditing = !!subscription
  const isRental = subscription?.is_rental ?? false

  // Form state
  const [displayName, setDisplayName] = useState(initialData?.displayName || '')
  const [description, setDescription] = useState(initialData?.description || '')
  const [taskType, setTaskType] = useState<SubscriptionTaskType>(
    initialData?.taskType || 'collection'
  )
  const [triggerType, setTriggerType] = useState<SubscriptionTriggerType>(
    initialData?.triggerType || 'cron'
  )
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(
    initialData?.triggerConfig || defaultTriggerConfig.cron
  )
  const [teamId, setTeamId] = useState<number | null>(null)
  const [promptTemplate, setPromptTemplate] = useState(initialData?.promptTemplate || '')
  const [retryCount, setRetryCount] = useState(initialData?.retryCount ?? 0)
  const [timeoutSeconds, setTimeoutSeconds] = useState(initialData?.timeoutSeconds ?? 600)
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true)
  const [executionTarget, setExecutionTarget] = useState<SubscriptionExecutionTarget>(
    normalizeExecutionTarget(initialData?.executionTarget)
  )
  const [preserveHistory, setPreserveHistory] = useState(initialData?.preserveHistory ?? false)
  const [historyMessageCount, setHistoryMessageCount] = useState(10)
  const [visibility, setVisibility] = useState<SubscriptionVisibility>(
    initialData?.visibility || 'private'
  )
  const [marketWhitelistUsers, setMarketWhitelistUsers] = useState<SearchUser[]>([])
  const [availableDevices, setAvailableDevices] = useState<DeviceInfo[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)

  // Expiration state
  const [expirationType, setExpirationType] = useState<'none' | 'fixed_date' | 'duration_days'>(
    'none'
  )
  const [expirationDate, setExpirationDate] = useState<Date | undefined>(undefined)
  const [durationDays, setDurationDays] = useState<number>(30)

  // Knowledge base selection state
  const [knowledgeBaseRefs, setKnowledgeBaseRefs] = useState<SubscriptionKnowledgeBaseRef[]>([])

  // Skills selection state
  const [skillRefs, setSkillRefs] = useState<SubscriptionSkillRef[]>([])
  const [availableSkills, setAvailableSkills] = useState<UnifiedSkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<SubscriptionModel | null>(null)
  const [models, setModels] = useState<SubscriptionModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  // Repository/Branch state for code-type teams
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  // Teams for selection
  const [teams, setTeams] = useState<Team[]>([])
  const [teamsLoading, setTeamsLoading] = useState(false)

  // Submit state
  const [submitting, setSubmitting] = useState(false)

  // Developer notification settings state
  const [devNotificationLevel, setDevNotificationLevel] = useState<NotificationLevel>('notify')
  const [devNotificationChannels, setDevNotificationChannels] = useState<number[]>([])
  const [devAvailableChannels, setDevAvailableChannels] = useState<NotificationChannelInfo[]>([])
  const [channelBindingConfigs, setChannelBindingConfigs] = useState<
    NotificationChannelBindingConfig[]
  >([])
  const [bindingWaitingState, setBindingWaitingState] = useState<Record<number, boolean>>({})
  const [devSettingsLoading, setDevSettingsLoading] = useState(false)

  // Notification webhooks state
  const [notificationWebhooks, setNotificationWebhooks] = useState<NotificationWebhook[]>([])

  // Load developer notification settings
  useEffect(() => {
    const loadDeveloperSettings = async () => {
      if (isRental) return

      setDevSettingsLoading(true)
      try {
        if (isEditing && subscription) {
          const response = await subscriptionApis.getDeveloperNotificationSettings(subscription.id)
          setDevNotificationLevel(response.notification_level)
          setDevNotificationChannels(response.notification_channel_ids || [])
          setDevAvailableChannels(response.available_channels || [])
          setChannelBindingConfigs(response.channel_binding_configs || [])
        } else {
          setDevNotificationLevel('notify')
          setDevNotificationChannels([])
          setChannelBindingConfigs([])
          try {
            // Use the new API to get available channels without requiring a subscription
            const availableChannels = await userApis.getAvailableChannels()
            setDevAvailableChannels(availableChannels || [])
            setChannelBindingConfigs([])
          } catch {
            setDevAvailableChannels([])
            setChannelBindingConfigs([])
          }
        }
      } catch (error) {
        console.error('Failed to load developer notification settings:', error)
      } finally {
        setDevSettingsLoading(false)
      }
    }

    if (open) {
      loadDeveloperSettings()
    }
  }, [isEditing, subscription, isRental, open])

  // Determine if device mode is selected
  const isDeviceMode = executionTarget.type !== 'managed'

  // Load teams
  useEffect(() => {
    const loadTeams = async () => {
      setTeamsLoading(true)
      try {
        const response = await teamApis.getTeams({ page: 1, limit: 100 })
        const filteredTeams = response.items.filter(team => {
          const bindMode = team.bind_mode
          if (!bindMode || bindMode.length === 0) {
            return !isDeviceMode
          }
          if (isDeviceMode) {
            return bindMode.includes('task')
          }
          return bindMode.includes('chat') || bindMode.includes('code')
        })
        setTeams(filteredTeams)

        if (!isEditing && !isRental && filteredTeams.length > 0 && !isDeviceMode) {
          try {
            const defaultTeams = await userApis.getDefaultTeams()
            const chatDefault = defaultTeams.chat
            if (chatDefault) {
              const matchedTeam = filteredTeams.find(
                team =>
                  team.name === chatDefault.name &&
                  (team.namespace || 'default') === chatDefault.namespace
              )
              if (matchedTeam) {
                setTeamId(matchedTeam.id)
              }
            }
          } catch (error) {
            console.error('Failed to load default teams:', error)
          }
        }
      } catch (error) {
        console.error('Failed to load teams:', error)
      } finally {
        setTeamsLoading(false)
      }
    }
    if (open) {
      loadTeams()
    }
  }, [open, isEditing, isRental, isDeviceMode])

  // Load models
  useEffect(() => {
    const loadModels = async () => {
      setModelsLoading(true)
      try {
        const response = await modelApis.getUnifiedModels(undefined, false, 'all')
        const modelList: SubscriptionModel[] = (response.data || []).map((m: UnifiedModel) => ({
          name: m.name,
          displayName: m.displayName,
          provider: m.provider || undefined,
          modelId: m.modelId || undefined,
          type: m.type,
        }))
        setModels(modelList)
      } catch (error) {
        console.error('Failed to load models:', error)
        toast.error(t('common:errors.load_failed'))
      } finally {
        setModelsLoading(false)
      }
    }
    if (open) {
      loadModels()
    }
  }, [open, t])

  // Load skills
  // Load skills
  useEffect(() => {
    const loadSkills = async () => {
      setSkillsLoading(true)
      try {
        // Use scope='all' to include personal + group + public skills
        const response = await fetchUnifiedSkillsList({ scope: 'all' })
        setAvailableSkills(response)
      } catch (error) {
        console.error('Failed to load skills:', error)
      } finally {
        setSkillsLoading(false)
      }
    }
    if (open) {
      loadSkills()
    }
  }, [open])
  // Load devices
  useEffect(() => {
    const loadDevices = async () => {
      setDevicesLoading(true)
      try {
        const response = await deviceApis.getAllDevices()
        setAvailableDevices(response.items || [])
      } catch (error) {
        console.error('Failed to load devices:', error)
      } finally {
        setDevicesLoading(false)
      }
    }

    if (open) {
      loadDevices()
    }
  }, [open])

  // Auto-select device
  useEffect(() => {
    if (executionTarget.type === 'managed' || devicesLoading) {
      return
    }

    const matchedDevice = availableDevices.find(
      device => device.device_id === executionTarget.device_id
    )
    if (matchedDevice) {
      if (matchedDevice.device_type !== executionTarget.type) {
        setExecutionTarget({
          type: matchedDevice.device_type,
          device_id: matchedDevice.device_id,
        })
      }
      return
    }

    const preferredDevice = getPreferredDevice(availableDevices)
    if (!preferredDevice) {
      return
    }

    setExecutionTarget({
      type: preferredDevice.device_type,
      device_id: preferredDevice.device_id,
    })
  }, [availableDevices, devicesLoading, executionTarget])

  // Get selected team
  const selectedTeam = teams.find(t => t.id === teamId)

  // Check if selected team is code-type
  const isCodeTypeTeam =
    selectedTeam?.recommended_mode === 'code' || selectedTeam?.recommended_mode === 'both'

  // Check if selected team has model configured
  const teamHasModel = (() => {
    if (!selectedTeam?.bots || selectedTeam.bots.length === 0) {
      return false
    }
    return selectedTeam.bots.some(teamBot => {
      const agentConfig = teamBot.bot?.agent_config
      if (!agentConfig) return false
      return !!(agentConfig as Record<string, unknown>).bind_model
    })
  })()

  const compatibleProvider = getCompatibleProviderFromAgentType(selectedTeam?.agent_type)
  const selectableDevices = sortDevicesForSelection(availableDevices)
  const hasSelectableDevices = selectableDevices.length > 0

  // Determine if model selection is required
  const modelRequired = isRental ? !selectedModel : !teamHasModel && !selectedModel

  // Reset form when subscription changes
  useEffect(() => {
    if (subscription) {
      setDisplayName(subscription.display_name)
      setDescription(subscription.description || '')
      setTaskType(subscription.task_type)
      setTriggerType(subscription.trigger_type)
      setTriggerConfig(subscription.trigger_config)
      setTeamId(subscription.team_id)
      setPromptTemplate(subscription.prompt_template)
      setRetryCount(subscription.retry_count)
      setTimeoutSeconds(subscription.timeout_seconds || 600)
      setEnabled(subscription.enabled)
      setExecutionTarget(normalizeExecutionTarget(subscription.execution_target))
      setPreserveHistory(subscription.preserve_history || false)
      setHistoryMessageCount(subscription.history_message_count || 10)
      setVisibility(subscription.visibility || 'private')
      setMarketWhitelistUsers(
        (subscription.market_whitelist_user_ids || []).map(userId => ({
          id: userId,
          user_name: `ID: ${userId}`,
        }))
      )
      setKnowledgeBaseRefs(subscription.knowledge_base_refs || [])
      setSkillRefs(subscription.skill_refs || [])
      setNotificationWebhooks(subscription.notification_webhooks || [])
      const repoInfo = buildRepoInfoFromSubscription(subscription)
      setSelectedRepo(repoInfo)
      setSelectedBranch(
        repoInfo && subscription.branch_name
          ? {
              name: subscription.branch_name,
              protected: false,
              default: false,
            }
          : null
      )
      if (subscription.model_ref) {
        setSelectedModel({
          name: subscription.model_ref.name,
          displayName: subscription.model_ref.name,
        })
      } else {
        setSelectedModel(null)
      }
      // Restore expiration state from subscription
      if (subscription.expires_at) {
        setExpirationType('fixed_date')
        setExpirationDate(new Date(subscription.expires_at))
      } else {
        setExpirationType('none')
        setExpirationDate(undefined)
      }
      setDurationDays(30)
    } else {
      setDisplayName(initialData?.displayName || '')
      setDescription(initialData?.description || '')
      setTaskType(initialData?.taskType || 'collection')
      setTriggerType(initialData?.triggerType || 'cron')
      setTriggerConfig(
        initialData?.triggerConfig || defaultTriggerConfig[initialData?.triggerType || 'cron']
      )
      setTeamId(null)
      setPromptTemplate(initialData?.promptTemplate || '')
      setRetryCount(initialData?.retryCount ?? 0)
      setTimeoutSeconds(initialData?.timeoutSeconds ?? 600)
      setEnabled(initialData?.enabled ?? true)
      setExecutionTarget(normalizeExecutionTarget(initialData?.executionTarget))
      setPreserveHistory(initialData?.preserveHistory ?? false)
      setHistoryMessageCount(10)
      setVisibility(initialData?.visibility || 'private')
      setMarketWhitelistUsers([])
      setSelectedRepo(null)
      setSelectedBranch(null)
      setSelectedModel(null)
      setKnowledgeBaseRefs([])
      setSkillRefs([])
      setNotificationWebhooks([])
      // Reset expiration state
      setExpirationType('none')
      setExpirationDate(undefined)
      setDurationDays(30)
    }
  }, [subscription, open, initialData])

  // Update selected model display name when models load
  useEffect(() => {
    if (selectedModel && models.length > 0) {
      const foundModel = models.find(m => m.name === selectedModel.name)
      if (foundModel && foundModel.displayName !== selectedModel.displayName) {
        setSelectedModel(foundModel)
      }
    }
  }, [models, selectedModel])

  // Clear incompatible model selection when team changes
  useEffect(() => {
    if (!selectedModel || !compatibleProvider) return
    const matchedModel = models.find(model => model.name === selectedModel.name)
    const resolvedProvider = matchedModel?.provider || selectedModel.provider
    if (resolvedProvider && resolvedProvider !== compatibleProvider) {
      setSelectedModel(null)
    }
  }, [compatibleProvider, models, selectedModel])

  // Handle team change - reset repo/branch when team changes
  const handleTeamChange = useCallback((newTeamId: number | null) => {
    setTeamId(newTeamId)
    setSelectedRepo(null)
    setSelectedBranch(null)
  }, [])

  // Handle submit
  const handleSubmit = useCallback(async () => {
    // Validation
    if (!displayName.trim()) {
      toast.error(t('validation_display_name_required'))
      return
    }

    if (executionTarget.type !== 'managed' && !executionTarget.device_id) {
      toast.error(t('validation_execution_target_device_required'))
      return
    }

    if (executionTarget.type !== 'managed' && !hasSelectableDevices) {
      toast.error(t('validation_execution_target_no_devices'))
      return
    }

    if (isRental) {
      if (!selectedModel) {
        toast.error(t('validation_model_required'))
        return
      }
    } else {
      if (!teamId) {
        toast.error(t('validation_team_required'))
        return
      }
      if (!promptTemplate.trim()) {
        toast.error(t('validation_prompt_required'))
        return
      }

      const team = teams.find(t => t.id === teamId)
      const hasTeamModel = team?.bots?.some(teamBot => {
        const agentConfig = teamBot.bot?.agent_config
        return agentConfig && !!(agentConfig as Record<string, unknown>).bind_model
      })

      if (!hasTeamModel && !selectedModel) {
        toast.error(t('validation_model_required'))
        return
      }
    }

    // Validate interval trigger minimum 20 minutes
    const intervalError = validateIntervalTrigger(triggerType, triggerConfig, t)
    if (intervalError) {
      toast.error(intervalError)
      return
    }

    setSubmitting(true)
    try {
      const marketWhitelistUserIds = Array.from(new Set(marketWhitelistUsers.map(user => user.id)))

      if (isEditing && subscription) {
        const updateData: SubscriptionUpdateRequest = {
          display_name: displayName,
          description: description || undefined,
          task_type: taskType,
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          retry_count: retryCount,
          timeout_seconds: timeoutSeconds,
          enabled,
          execution_target: executionTarget,
          preserve_history: preserveHistory,
          history_message_count: preserveHistory ? historyMessageCount : undefined,
          ...(isRental
            ? {}
            : {
                team_id: teamId ?? undefined,
                prompt_template: promptTemplate,
                visibility,
                market_whitelist_user_ids: marketWhitelistUserIds,
              }),
          ...(!isRental &&
            selectedRepo && {
              git_repo: selectedRepo.git_repo,
              git_repo_id: selectedRepo.git_repo_id,
              git_domain: selectedRepo.git_domain,
              branch_name: selectedBranch?.name || 'main',
            }),
          model_ref: selectedModel ? { name: selectedModel.name, namespace: 'default' } : undefined,
          force_override_bot_model: !!selectedModel,
          knowledge_base_refs: knowledgeBaseRefs.length > 0 ? knowledgeBaseRefs : undefined,
          skill_refs: skillRefs.length > 0 ? skillRefs : undefined,
          notification_webhooks: notificationWebhooks.length > 0 ? notificationWebhooks : undefined,
          // Expiration settings
          ...(expirationType !== 'none' && {
            expires_at:
              expirationType === 'fixed_date' && expirationDate
                ? expirationDate.toISOString()
                : expirationType === 'duration_days'
                  ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString()
                  : undefined,
          }),
        }
        await subscriptionApis.updateSubscription(subscription.id, updateData)

        if (!isRental) {
          try {
            await subscriptionApis.updateDeveloperNotificationSettings(subscription.id, {
              notification_level: devNotificationLevel,
              notification_channel_ids: devNotificationChannels,
              channel_binding_configs: channelBindingConfigs,
            })
          } catch (error) {
            console.error('Failed to update developer notification settings:', error)
          }
        }

        toast.success(t('update_success'))
      } else {
        const generatedName =
          displayName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50) || `subscription-${Date.now()}`

        const createData: SubscriptionCreateRequest = {
          name: generatedName,
          display_name: displayName,
          description: description || undefined,
          task_type: taskType,
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          team_id: teamId!,
          prompt_template: promptTemplate,
          retry_count: retryCount,
          timeout_seconds: timeoutSeconds,
          enabled,
          execution_target: executionTarget,
          preserve_history: preserveHistory,
          history_message_count: preserveHistory ? historyMessageCount : undefined,
          visibility,
          market_whitelist_user_ids: marketWhitelistUserIds,
          ...(selectedRepo && {
            git_repo: selectedRepo.git_repo,
            git_repo_id: selectedRepo.git_repo_id,
            git_domain: selectedRepo.git_domain,
            branch_name: selectedBranch?.name || 'main',
          }),
          model_ref: selectedModel ? { name: selectedModel.name, namespace: 'default' } : undefined,
          force_override_bot_model: !!selectedModel,
          knowledge_base_refs: knowledgeBaseRefs.length > 0 ? knowledgeBaseRefs : undefined,
          skill_refs: skillRefs.length > 0 ? skillRefs : undefined,
          notification_webhooks: notificationWebhooks.length > 0 ? notificationWebhooks : undefined,
          // Expiration settings
          ...(expirationType !== 'none' && {
            expires_at:
              expirationType === 'fixed_date' && expirationDate
                ? expirationDate.toISOString()
                : expirationType === 'duration_days'
                  ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString()
                  : undefined,
          }),
        }
        const createdSubscription = await subscriptionApis.createSubscription(createData)

        try {
          await subscriptionApis.updateDeveloperNotificationSettings(createdSubscription.id, {
            notification_level: devNotificationLevel,
            notification_channel_ids: devNotificationChannels,
            channel_binding_configs: channelBindingConfigs,
          })
        } catch (error) {
          console.error('Failed to update developer notification settings:', error)
        }

        toast.success(t('create_success'))
      }
      onSuccess()
      onOpenChange(false)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : t('save_failed')
      console.error('Failed to save subscription:', error)
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
    executionTarget,
    hasSelectableDevices,
    preserveHistory,
    historyMessageCount,
    visibility,
    marketWhitelistUsers,
    selectedRepo,
    selectedBranch,
    selectedModel,
    knowledgeBaseRefs,
    skillRefs,
    notificationWebhooks,
    isEditing,
    isRental,
    subscription,
    onSuccess,
    onOpenChange,
    t,
    teams,
    devNotificationLevel,
    devNotificationChannels,
    channelBindingConfigs,
    expirationType,
    expirationDate,
    durationDays,
  ])

  const startBindingSession = useCallback(
    async (channelId: number, bindPrivate: boolean, bindGroup: boolean) => {
      await subscriptionApis.startDeveloperBindingSession(subscription?.id || null, {
        channel_id: channelId,
        bind_private: bindPrivate,
        bind_group: bindGroup,
      })
      setBindingWaitingState(prev => ({ ...prev, [channelId]: true }))
    },
    [subscription?.id]
  )

  const cancelBindingSession = useCallback(
    async (channelId: number) => {
      await subscriptionApis.cancelDeveloperBindingSession(subscription?.id || null, {
        channel_id: channelId,
      })
      setBindingWaitingState(prev => ({ ...prev, [channelId]: false }))
    },
    [subscription?.id]
  )

  // Listen for group info received event from WebSocket
  useEffect(() => {
    if (!socket) return

    const bindingUpdateHandler = (payload: SubscriptionBindingUpdatePayload) => {
      setDevAvailableChannels(prev =>
        prev.map(channel =>
          channel.id === payload.channel_id && payload.private_bound
            ? {
                ...channel,
                is_bound: true,
              }
            : channel
        )
      )

      if (payload.completed && !payload.group_bound) {
        setBindingWaitingState(prev => ({ ...prev, [payload.channel_id]: false }))
      }
    }

    const handler = (payload: SubscriptionGroupInfoPayload) => {
      // Update channelBindingConfigs with group info
      setChannelBindingConfigs(prev =>
        prev.map(item =>
          item.channel_id === payload.channel_id
            ? {
                ...item,
                group_conversation_id: payload.group_conversation_id,
                group_name: payload.group_name,
              }
            : item
        )
      )
      // Update binding waiting state
      setBindingWaitingState(prev => ({ ...prev, [payload.channel_id]: false }))
      // Show success toast
      toast.success(t('notification_settings.binding_success'))
    }

    socket.on('subscription:group_binding_updated', bindingUpdateHandler)
    socket.on('subscription:group_info_received', handler)
    return () => {
      socket.off('subscription:group_binding_updated', bindingUpdateHandler)
      socket.off('subscription:group_info_received', handler)
    }
  }, [socket, t])

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
          {/* Section 1: Basic Info */}
          <BasicInfoSection
            displayName={displayName}
            setDisplayName={setDisplayName}
            description={description}
            setDescription={setDescription}
            enabled={enabled}
            setEnabled={setEnabled}
            visibility={visibility}
            setVisibility={setVisibility}
            marketWhitelistUsers={marketWhitelistUsers}
            setMarketWhitelistUsers={setMarketWhitelistUsers}
            isRental={isRental}
          />

          {/* Section 2: Task Settings (Send Area) */}
          {!isRental && (
            <SendAreaSection
              promptTemplate={promptTemplate}
              setPromptTemplate={setPromptTemplate}
              triggerType={triggerType}
              triggerConfig={triggerConfig}
              teamId={teamId}
              setTeamId={handleTeamChange}
              teams={teams}
              teamsLoading={teamsLoading}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              models={models}
              modelsLoading={modelsLoading}
              modelRequired={modelRequired}
              compatibleProvider={compatibleProvider ?? undefined}
              skillRefs={skillRefs}
              setSkillRefs={setSkillRefs}
              availableSkills={availableSkills}
              skillsLoading={skillsLoading}
              knowledgeBaseRefs={knowledgeBaseRefs}
              setKnowledgeBaseRefs={setKnowledgeBaseRefs}
              preserveHistory={preserveHistory}
              setPreserveHistory={setPreserveHistory}
              historyMessageCount={historyMessageCount}
              setHistoryMessageCount={setHistoryMessageCount}
              executionTarget={executionTarget}
              setExecutionTarget={setExecutionTarget}
              availableDevices={availableDevices}
              devicesLoading={devicesLoading}
              isRental={isRental}
            />
          )}

          {/* Invalid Schedule Warning - Only show when editing an invalid subscription */}
          {isEditing && subscription && subscription.trigger_config_valid === false && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-amber-800">
                    {t('invalid_schedule_edit_warning_title')}
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    {subscription.trigger_config_error || t('invalid_schedule_edit_warning_desc')}
                  </p>
                  <p className="text-xs text-amber-700 mt-1">{t('invalid_schedule_edit_action')}</p>
                </div>
              </div>
            </div>
          )}

          {/* Section 3: Subscription Options */}
          <SubscriptionOptionsSection
            triggerType={triggerType}
            setTriggerType={setTriggerType}
            triggerConfig={triggerConfig}
            setTriggerConfig={setTriggerConfig}
            isCodeTypeTeam={isCodeTypeTeam}
            selectedRepo={selectedRepo}
            setSelectedRepo={setSelectedRepo}
            selectedBranch={selectedBranch}
            setSelectedBranch={setSelectedBranch}
            retryCount={retryCount}
            setRetryCount={setRetryCount}
            timeoutSeconds={timeoutSeconds}
            setTimeoutSeconds={setTimeoutSeconds}
            expirationType={expirationType}
            setExpirationType={setExpirationType}
            expirationDate={expirationDate}
            setExpirationDate={setExpirationDate}
            durationDays={durationDays}
            setDurationDays={setDurationDays}
          />

          {/* Webhook API Usage - Only show for event trigger with webhook when editing */}
          {isEditing &&
            subscription &&
            triggerType === 'event' &&
            triggerConfig.event_type === 'webhook' &&
            subscription.webhook_url && <WebhookApiSection subscription={subscription} />}

          {/* Section 4: Notification Settings */}
          {!isRental && (
            <NotificationSection
              devNotificationLevel={devNotificationLevel}
              setDevNotificationLevel={setDevNotificationLevel}
              devNotificationChannels={devNotificationChannels}
              setDevNotificationChannels={setDevNotificationChannels}
              devAvailableChannels={devAvailableChannels}
              devSettingsLoading={devSettingsLoading}
              notificationWebhooks={notificationWebhooks}
              setNotificationWebhooks={setNotificationWebhooks}
              channelBindingConfigs={channelBindingConfigs}
              setChannelBindingConfigs={setChannelBindingConfigs}
              onStartBinding={startBindingSession}
              onCancelBinding={cancelBindingSession}
              bindingWaitingState={bindingWaitingState}
            />
          )}
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
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting}
            className="min-w-[100px]"
          >
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
