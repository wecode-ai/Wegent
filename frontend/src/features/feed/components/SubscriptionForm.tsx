'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription creation/edit form component.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Check, Terminal, Brain, ChevronDown, Eye, EyeOff } from 'lucide-react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { subscriptionApis } from '@/apis/subscription'
import { teamApis } from '@/apis/team'
import { modelApis, UnifiedModel } from '@/apis/models'
import type { Team, GitRepoInfo, GitBranch } from '@/types/api'
import type {
  Subscription,
  SubscriptionCreateRequest,
  SubscriptionTaskType,
  SubscriptionTriggerType,
  SubscriptionUpdateRequest,
  SubscriptionVisibility,
} from '@/types/subscription'
import { toast } from 'sonner'
import { CronSchedulePicker } from './CronSchedulePicker'
import { RepositorySelector, BranchSelector } from '@/features/tasks/components/selector'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { cn, parseUTCDate } from '@/lib/utils'
import { getCompatibleProviderFromAgentType } from '@/utils/modelCompatibility'

// Model type for selector
interface SubscriptionModel {
  name: string
  displayName?: string | null
  provider?: string
  modelId?: string
  type?: string
}

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

export function SubscriptionForm({
  open,
  onOpenChange,
  subscription,
  onSuccess,
  initialData,
}: SubscriptionFormProps) {
  const { t } = useTranslation('feed')
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
  const [timeoutSeconds, setTimeoutSeconds] = useState(initialData?.timeoutSeconds ?? 600) // Default 10 minutes
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true)
  const [preserveHistory, setPreserveHistory] = useState(initialData?.preserveHistory ?? false) // History preservation
  const [visibility, setVisibility] = useState<SubscriptionVisibility>(
    initialData?.visibility || 'private'
  ) // Visibility setting

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<SubscriptionModel | null>(null)
  const [models, setModels] = useState<SubscriptionModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [modelSearchValue, setModelSearchValue] = useState('')
  const promptTemplateRef = useRef<HTMLTextAreaElement>(null)

  // Repository/Branch state for code-type teams
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  // Teams for selection
  const [teams, setTeams] = useState<Team[]>([])
  const [teamsLoading, setTeamsLoading] = useState(false)

  // Submit state
  const [submitting, setSubmitting] = useState(false)

  // Load teams - only show teams with chat or code mode (exclude knowledge-only teams)
  useEffect(() => {
    const loadTeams = async () => {
      setTeamsLoading(true)
      try {
        const response = await teamApis.getTeams({ page: 1, limit: 100 })
        // Filter teams to only include those with chat or code mode
        const filteredTeams = response.items.filter(team => {
          const bindMode = team.bind_mode
          // If bind_mode is not set, include the team (backward compatibility)
          if (!bindMode || bindMode.length === 0) {
            return true
          }
          // Include team if it has chat or code mode
          return bindMode.includes('chat') || bindMode.includes('code')
        })
        setTeams(filteredTeams)
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

  // Load models
  useEffect(() => {
    const loadModels = async () => {
      setModelsLoading(true)
      try {
        const response = await modelApis.getUnifiedModels(undefined, false, 'all')
        console.log('Loaded models response:', response)
        const modelList: SubscriptionModel[] = (response.data || []).map((m: UnifiedModel) => ({
          name: m.name,
          displayName: m.displayName,
          provider: m.provider || undefined,
          modelId: m.modelId || undefined,
          type: m.type,
        }))
        console.log('Processed model list:', modelList)
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

  // Get selected team
  const selectedTeam = teams.find(t => t.id === teamId)

  // Check if selected team is code-type (needs repository selection)
  const isCodeTypeTeam =
    selectedTeam?.recommended_mode === 'code' || selectedTeam?.recommended_mode === 'both'

  // Check if selected team has model configured in any of its bots
  const teamHasModel = (() => {
    if (!selectedTeam?.bots || selectedTeam.bots.length === 0) {
      return false
    }
    // Check if any bot has a model configured (bind_model in agent_config)
    return selectedTeam.bots.some(teamBot => {
      const agentConfig = teamBot.bot?.agent_config
      if (!agentConfig) return false
      // Check for bind_model field which indicates a model is configured
      return !!(agentConfig as Record<string, unknown>).bind_model
    })
  })()

  const compatibleProvider = getCompatibleProviderFromAgentType(selectedTeam?.agent_type)

  // Determine if model selection is required
  // For rental subscriptions: model is REQUIRED (must select a model to use)
  // For non-rental: required only if team has no model configured
  const modelRequired = isRental ? !selectedModel : !teamHasModel && !selectedModel
  const promptVariables = [
    '{{date}}',
    '{{time}}',
    '{{datetime}}',
    '{{subscription_name}}',
    '{{webhook_data}}',
  ]
  const promptVariablesHint = t('prompt_variables_hint')
  const promptVariablesLabel = promptVariablesHint.split(/[:：]/)[0]?.trim() || promptVariablesHint
  const promptVariablesDelimiter = promptVariablesHint.includes('：') ? '：' : ':'

  // Handle repository change
  const handleRepoChange = useCallback((repo: GitRepoInfo | null) => {
    setSelectedRepo(repo)
    setSelectedBranch(null) // Reset branch when repo changes
  }, [])

  // Handle branch change
  const handleBranchChange = useCallback((branch: GitBranch | null) => {
    setSelectedBranch(branch)
  }, [])

  const handleInsertPromptVariable = useCallback((variable: string) => {
    const textarea = promptTemplateRef.current
    if (!textarea) {
      setPromptTemplate(prevValue => `${prevValue}${variable}`)
      return
    }

    const currentValue = textarea.value
    const selectionStart = textarea.selectionStart ?? currentValue.length
    const selectionEnd = textarea.selectionEnd ?? currentValue.length
    const nextValue =
      currentValue.slice(0, selectionStart) + variable + currentValue.slice(selectionEnd)

    setPromptTemplate(nextValue)
    requestAnimationFrame(() => {
      textarea.focus()
      const caretPosition = selectionStart + variable.length
      textarea.setSelectionRange(caretPosition, caretPosition)
    })
  }, [])

  // Handle team change - reset repo/branch when team changes
  const handleTeamChange = useCallback((value: string) => {
    const newTeamId = parseInt(value)
    setTeamId(newTeamId)
    // Reset repository selection when team changes
    setSelectedRepo(null)
    setSelectedBranch(null)
  }, [])

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
      setPreserveHistory(subscription.preserve_history || false)
      setVisibility(subscription.visibility || 'private')
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
      // Restore model selection from subscription
      if (subscription.model_ref) {
        setSelectedModel({
          name: subscription.model_ref.name,
          displayName: subscription.model_ref.name, // Will be updated when models load
        })
      } else {
        setSelectedModel(null)
      }
    } else {
      // Use initialData if provided, otherwise use defaults
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
      setPreserveHistory(initialData?.preserveHistory ?? false)
      setVisibility(initialData?.visibility || 'private')
      setSelectedRepo(null)
      setSelectedBranch(null)
      setSelectedModel(null)
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

  // Handle trigger type change
  const handleTriggerTypeChange = useCallback((value: SubscriptionTriggerType) => {
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

    // For rental subscriptions: model is REQUIRED
    if (isRental) {
      if (!selectedModel) {
        toast.error(t('validation_model_required'))
        return
      }
    } else {
      // For non-rental subscriptions: team, prompt, and model (if team has no model) are required
      if (!teamId) {
        toast.error(t('validation_team_required'))
        return
      }
      if (!promptTemplate.trim()) {
        toast.error(t('validation_prompt_required'))
        return
      }

      // Check if model is required but not selected
      // Find the team to check if it has model configured
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

    setSubmitting(true)
    try {
      if (isEditing && subscription) {
        // For rental subscriptions, only update allowed fields (not team, prompt, visibility)
        const updateData: SubscriptionUpdateRequest = {
          display_name: displayName,
          description: description || undefined,
          task_type: taskType,
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          retry_count: retryCount,
          timeout_seconds: timeoutSeconds,
          enabled,
          preserve_history: preserveHistory,
          // Only include team_id, prompt_template, visibility for non-rental subscriptions
          ...(isRental
            ? {}
            : {
                team_id: teamId ?? undefined,
                prompt_template: promptTemplate,
                visibility,
              }),
          // Include git repo info if selected (only for non-rental)
          ...(!isRental &&
            selectedRepo && {
              git_repo: selectedRepo.git_repo,
              git_repo_id: selectedRepo.git_repo_id,
              git_domain: selectedRepo.git_domain,
              branch_name: selectedBranch?.name || 'main',
            }),
          // Include model selection - always override bot model when specified
          model_ref: selectedModel ? { name: selectedModel.name, namespace: 'default' } : undefined,
          force_override_bot_model: !!selectedModel, // Always override when model is selected
        }
        await subscriptionApis.updateSubscription(subscription.id, updateData)
        toast.success(t('update_success'))
      } else {
        // Generate name from display name
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
          preserve_history: preserveHistory,
          visibility,
          // Include git repo info if selected
          ...(selectedRepo && {
            git_repo: selectedRepo.git_repo,
            git_repo_id: selectedRepo.git_repo_id,
            git_domain: selectedRepo.git_domain,
            branch_name: selectedBranch?.name || 'main',
          }),
          // Include model selection - always override bot model when specified
          model_ref: selectedModel ? { name: selectedModel.name, namespace: 'default' } : undefined,
          force_override_bot_model: !!selectedModel, // Always override when model is selected
        }
        await subscriptionApis.createSubscription(createData)
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
    preserveHistory,
    visibility,
    selectedRepo,
    selectedBranch,
    selectedModel,
    isEditing,
    isRental,
    subscription,
    onSuccess,
    onOpenChange,
    t,
    teams,
  ])

  // Filter models based on search
  const compatibleModels = compatibleProvider
    ? models.filter(model => model.provider === compatibleProvider)
    : models

  const filteredModels = compatibleModels.filter(model => {
    const searchLower = modelSearchValue.toLowerCase()
    return (
      model.name.toLowerCase().includes(searchLower) ||
      (model.displayName && model.displayName.toLowerCase().includes(searchLower)) ||
      (model.provider && model.provider.toLowerCase().includes(searchLower))
    )
  })

  // Clear incompatible model selection when team changes
  useEffect(() => {
    if (!selectedModel || !compatibleProvider) return
    const matchedModel = models.find(model => model.name === selectedModel.name)
    const resolvedProvider = matchedModel?.provider || selectedModel.provider
    if (resolvedProvider && resolvedProvider !== compatibleProvider) {
      setSelectedModel(null)
    }
  }, [compatibleProvider, models, selectedModel])

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
        // Convert UTC ISO string to local Date object
        const getLocalDate = (isoString: string | undefined): Date | undefined => {
          if (!isoString) return undefined
          // Use parseUTCDate to correctly parse UTC time from backend
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
                  onValueChange={value => setTaskType(value as SubscriptionTaskType)}
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

              {/* Team Selection - Hidden for rental subscriptions */}
              {!isRental && (
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
              )}

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

              {/* Model Selection */}
              <div className="space-y-3 rounded-lg border border-border bg-background-secondary/30 p-4">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium text-text-secondary">
                    {t('model_settings')}
                  </span>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium">{t('select_model')}</Label>
                  <Popover open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={modelSelectorOpen}
                        className="w-full justify-between h-10"
                        disabled={modelsLoading}
                      >
                        {modelsLoading ? (
                          t('common:loading')
                        ) : selectedModel ? (
                          <span className="truncate">
                            {selectedModel.displayName || selectedModel.name}
                          </span>
                        ) : (
                          <span className="text-text-muted">{t('select_model_placeholder')}</span>
                        )}
                        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      className={cn(
                        'w-[400px] p-0',
                        'max-h-[var(--radix-popover-content-available-height,360px)]',
                        'flex flex-col overflow-hidden'
                      )}
                      align="start"
                    >
                      <Command className="flex flex-col flex-1 min-h-0">
                        <CommandInput
                          placeholder={t('search_model')}
                          value={modelSearchValue}
                          onValueChange={setModelSearchValue}
                        />
                        <CommandList
                          className="min-h-[36px] max-h-[240px] overflow-y-auto flex-1"
                          onWheel={event => {
                            event.stopPropagation()
                          }}
                        >
                          <CommandEmpty>{t('no_model_found')}</CommandEmpty>
                          <CommandGroup>
                            {/* Option to clear selection */}
                            <CommandItem
                              value="__clear__"
                              onSelect={() => {
                                setSelectedModel(null)
                                setModelSelectorOpen(false)
                                setModelSearchValue('')
                              }}
                            >
                              <span className="text-text-muted">{t('use_default_model')}</span>
                            </CommandItem>
                            {filteredModels.map(model => (
                              <CommandItem
                                key={model.name}
                                value={model.name}
                                onSelect={() => {
                                  setSelectedModel(model)
                                  setModelSelectorOpen(false)
                                  setModelSearchValue('')
                                }}
                              >
                                <div className="flex flex-col">
                                  <span
                                    className={cn(
                                      selectedModel?.name === model.name && 'font-medium'
                                    )}
                                  >
                                    {model.displayName || model.name}
                                  </span>
                                  <span className="text-xs text-text-muted">
                                    {model.provider} · {model.modelId}
                                  </span>
                                </div>
                                {selectedModel?.name === model.name && (
                                  <Check className="ml-auto h-4 w-4" />
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-text-muted">
                    {modelRequired ? (
                      <span className="text-destructive">{t('model_required_hint')}</span>
                    ) : (
                      t('model_hint')
                    )}
                  </p>
                </div>
              </div>

              {/* Preserve History */}
              <div className="flex items-center justify-between pt-2">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">{t('preserve_history')}</Label>
                  <p className="text-xs text-text-muted">{t('preserve_history_hint')}</p>
                </div>
                <Switch checked={preserveHistory} onCheckedChange={setPreserveHistory} />
              </div>
              {/* Visibility - Hidden for rental subscriptions */}
              {!isRental && (
                <div className="space-y-2 pt-2">
                  <Label className="text-sm font-medium">{t('visibility')}</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={visibility === 'private' ? 'primary' : 'outline'}
                      size="sm"
                      onClick={() => setVisibility('private')}
                      className="flex-1"
                    >
                      <EyeOff className="h-4 w-4 mr-1.5" />
                      {t('visibility_private')}
                    </Button>
                    <Button
                      type="button"
                      variant={visibility === 'public' ? 'primary' : 'outline'}
                      size="sm"
                      onClick={() => setVisibility('public')}
                      className="flex-1"
                    >
                      <Eye className="h-4 w-4 mr-1.5" />
                      {t('visibility_public')}
                    </Button>
                    <Button
                      type="button"
                      variant={visibility === 'market' ? 'primary' : 'outline'}
                      size="sm"
                      onClick={() => setVisibility('market')}
                      className="flex-1"
                    >
                      <Eye className="h-4 w-4 mr-1.5" />
                      {t('visibility_market')}
                    </Button>
                  </div>
                  <p className="text-xs text-text-muted">
                    {visibility === 'market' ? t('visibility_market_hint') : t('visibility_hint')}
                  </p>
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
                subscription &&
                triggerType === 'event' &&
                triggerConfig.event_type === 'webhook' &&
                subscription.webhook_url && <WebhookApiSection subscription={subscription} />}

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

          {/* Full Width - Prompt Template - Hidden for rental subscriptions */}
          {!isRental && (
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
                  ref={promptTemplateRef}
                  value={promptTemplate}
                  onChange={e => setPromptTemplate(e.target.value)}
                  placeholder={t('prompt_template_placeholder')}
                  rows={5}
                  className="resize-none"
                />
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <span>
                    {promptVariablesLabel}
                    {promptVariablesDelimiter}
                  </span>
                  {promptVariables.map(variable => (
                    <Button
                      key={variable}
                      type="button"
                      size="sm"
                      variant="outline"
                      className={cn(
                        'h-7 px-2 text-[11px] rounded-full border-border',
                        'bg-surface text-text-secondary hover:text-text-primary hover:bg-hover'
                      )}
                      onClick={() => handleInsertPromptVariable(variable)}
                    >
                      {variable}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
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
