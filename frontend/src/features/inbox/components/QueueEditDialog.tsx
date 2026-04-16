// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SearchableSelect, type SearchableSelectItem } from '@/components/ui/searchable-select'
import { Tag } from '@/components/ui/tag'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'
import { toast } from 'sonner'
import {
  createWorkQueue,
  updateWorkQueue,
  type WorkQueue,
  type WorkQueueCreateRequest,
  type WorkQueueUpdateRequest,
  type QueueVisibility,
  type SubscriptionRef,
  type TeamRef,
} from '@/apis/work-queue'
import { subscriptionApis } from '@/apis/subscription'
import { userApis } from '@/apis/user'
import { useTeamContext } from '@/contexts/TeamContext'
import { getSharedTagStyle as getSharedBadgeStyle } from '@/utils/styles'
import { useInboxContext } from '../contexts/inboxContext'

type ProcessMode = 'subscription' | 'direct_agent'

interface QueueEditDialogProps {
  queue?: WorkQueue | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function QueueEditDialog({ queue, open, onOpenChange }: QueueEditDialogProps) {
  const { t } = useTranslation('inbox')
  const { refreshQueues } = useInboxContext()

  const isEditing = !!queue

  // Form state
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<QueueVisibility>('private')

  // Auto-process state
  const [autoProcessEnabled, setAutoProcessEnabled] = useState(false)
  const [processMode, setProcessMode] = useState<ProcessMode>('direct_agent')

  // Subscription mode state
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<string>('')
  const [subscriptions, setSubscriptions] = useState<
    Array<{ id: number; name: string; namespace: string; displayName: string; userId: number }>
  >([])
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false)

  // Direct agent mode state - use shared TeamContext instead of local fetch
  const [selectedTeamId, setSelectedTeamId] = useState<string>('')
  const { teams, isTeamsLoading: loadingTeams } = useTeamContext()
  const sharedBadgeStyle = getSharedBadgeStyle()

  const [loading, setLoading] = useState(false)

  // Fetch subscriptions for subscription mode
  const fetchSubscriptions = useCallback(async () => {
    setLoadingSubscriptions(true)
    try {
      const response = await subscriptionApis.getSubscriptions(
        { page: 1, limit: 100 },
        undefined,
        'event'
      )
      // Filter to inbox_message event type subscriptions
      const items = response.items || []
      const inboxSubscriptions = items
        .filter(sub => {
          const triggerConfig = sub.trigger_config as Record<string, unknown>
          return triggerConfig?.event_type === 'inbox_message'
        })
        .map(sub => ({
          id: sub.id,
          name: sub.name,
          namespace: sub.namespace || 'default',
          displayName: sub.display_name || sub.name,
          userId: sub.user_id,
        }))
      setSubscriptions(inboxSubscriptions)
    } catch (error) {
      console.error('Failed to fetch subscriptions:', error)
      setSubscriptions([])
    } finally {
      setLoadingSubscriptions(false)
    }
  }, [])

  // Reset form when dialog opens/closes or queue changes
  useEffect(() => {
    if (open && queue) {
      setName(queue.name)
      setDisplayName(queue.displayName)
      setDescription(queue.description || '')
      setVisibility(queue.visibility)
      const mode = (queue.autoProcess?.mode as ProcessMode) || 'subscription'
      setProcessMode(mode)
      setAutoProcessEnabled(queue.autoProcess?.enabled || false)
      setSelectedSubscriptionId('')
      setSelectedTeamId('')
    } else if (open && !queue) {
      setName('')
      setDisplayName('')
      setDescription('')
      setVisibility('private')
      setAutoProcessEnabled(false)
      setProcessMode('direct_agent')
      setSelectedSubscriptionId('')
      setSelectedTeamId('')
    }
  }, [open, queue])

  // Fetch subscriptions when auto-process is enabled in subscription mode
  useEffect(() => {
    if (open && autoProcessEnabled && processMode === 'subscription') {
      fetchSubscriptions()
    }
  }, [open, autoProcessEnabled, processMode, fetchSubscriptions])

  // Match subscription after both queue data and subscriptions are loaded
  useEffect(() => {
    if (queue?.autoProcess?.subscriptionRef && subscriptions.length > 0) {
      const ref = queue.autoProcess.subscriptionRef
      const match = subscriptions.find(
        s => s.name === ref.name && s.namespace === ref.namespace && s.userId === ref.userId
      )
      if (match) {
        setSelectedSubscriptionId(String(match.id))
      }
    }
  }, [queue, subscriptions])

  // Match team after both queue data and teams are loaded
  useEffect(() => {
    if (queue?.autoProcess?.teamRef && teams.length > 0) {
      const ref = queue.autoProcess.teamRef
      const match = teams.find(
        t => t.name === ref.name && (t.namespace || 'default') === ref.namespace
      )
      if (match) {
        setSelectedTeamId(String(match.id))
      }
    }
  }, [queue, teams])

  // Auto-select system default chat team when switching to direct_agent mode with no selection
  useEffect(() => {
    if (processMode !== 'direct_agent' || teams.length === 0 || selectedTeamId) return

    // Skip if editing an existing queue that already has a teamRef (handled by the effect above)
    if (queue?.autoProcess?.teamRef) return

    // Fetch system default chat team and select it
    userApis
      .getDefaultTeams()
      .then(defaults => {
        const defaultChatTeamName = defaults.chat?.name
        if (defaultChatTeamName) {
          const defaultTeam = teams.find(t => t.name === defaultChatTeamName)
          if (defaultTeam) {
            setSelectedTeamId(String(defaultTeam.id))
            return
          }
        }
        // Fallback: select the first chat-compatible team
        const chatTeam = teams.find(
          t => !t.bind_mode || t.bind_mode.length === 0 || t.bind_mode.includes('chat')
        )
        if (chatTeam) {
          setSelectedTeamId(String(chatTeam.id))
        }
      })
      .catch(() => {
        // Fallback on error: select the first chat-compatible team
        const chatTeam = teams.find(
          t => !t.bind_mode || t.bind_mode.length === 0 || t.bind_mode.includes('chat')
        )
        if (chatTeam) {
          setSelectedTeamId(String(chatTeam.id))
        }
      })
  }, [processMode, teams, selectedTeamId, queue])

  // Build SearchableSelectItem list for team selector
  const teamSelectItems: SearchableSelectItem[] = useMemo(() => {
    return teams.map(team => {
      const isSharedTeam = team.share_status === 2 && team.user?.user_name
      const isGroupTeam = team.namespace && team.namespace !== 'default'
      return {
        value: String(team.id),
        label: team.name,
        searchText: team.name,
        content: (
          <div className="flex items-center gap-2 min-w-0" data-testid={`team-option-${team.name}`}>
            <TeamIconDisplay
              iconId={team.icon}
              size="sm"
              className="flex-shrink-0 text-text-muted"
            />
            <span
              className="font-medium text-xs text-text-secondary truncate flex-1 min-w-0"
              title={team.name}
            >
              {team.name}
            </span>
            {isGroupTeam && (
              <Tag className="ml-2 text-xs !m-0 flex-shrink-0" variant="info">
                {team.namespace}
              </Tag>
            )}
            {isSharedTeam && (
              <Tag
                className="ml-2 text-xs !m-0 flex-shrink-0"
                variant="default"
                style={sharedBadgeStyle}
              >
                {team.user?.user_name}
              </Tag>
            )}
          </div>
        ),
      }
    })
  }, [teams, sharedBadgeStyle])

  const handleSubmit = async () => {
    if (!displayName.trim()) {
      toast.error(t('queues.display_name_placeholder'))
      return
    }

    if (!isEditing && !name.trim()) {
      toast.error(t('queues.name_placeholder'))
      return
    }

    // Build subscriptionRef / teamRef from selected values
    let subscriptionRef: SubscriptionRef | undefined
    let teamRef: TeamRef | undefined

    if (autoProcessEnabled) {
      if (processMode === 'subscription' && selectedSubscriptionId) {
        const sub = subscriptions.find(s => String(s.id) === selectedSubscriptionId)
        if (sub) {
          subscriptionRef = {
            namespace: sub.namespace,
            name: sub.name,
            userId: sub.userId,
          }
        }
      } else if (processMode === 'direct_agent' && selectedTeamId) {
        const team = teams.find(t => String(t.id) === selectedTeamId)
        if (team) {
          teamRef = {
            namespace: team.namespace || 'default',
            name: team.name,
          }
        }
      }
    }

    setLoading(true)
    setLoading(true)
    try {
      if (isEditing && queue) {
        const updateData: WorkQueueUpdateRequest = {
          displayName,
          description: description || undefined,
          visibility,
          autoProcess: {
            enabled: autoProcessEnabled,
            mode: processMode,
            triggerMode: 'immediate',
            subscriptionRef,
            teamRef,
          },
        }
        await updateWorkQueue(queue.id, updateData)
        toast.success(t('queues.update_success'))
      } else {
        const createData: WorkQueueCreateRequest = {
          name,
          displayName,
          description: description || undefined,
          visibility,
          autoProcess: {
            enabled: autoProcessEnabled,
            mode: processMode,
            triggerMode: 'immediate',
            subscriptionRef,
            teamRef,
          },
        }
        await createWorkQueue(createData)
        toast.success(t('queues.create_success'))
      }
      await refreshQueues()
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to save queue:', error)
      toast.error(isEditing ? t('queues.update_failed') : t('queues.create_failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('queues.edit') : t('queues.create')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Name (only for create) */}
          {!isEditing && (
            <div className="space-y-2">
              <Label htmlFor="name">{t('queues.name')}</Label>
              <Input
                id="name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('queues.name_placeholder')}
                data-testid="queue-name-input"
              />
            </div>
          )}

          {/* Display name */}
          <div className="space-y-2">
            <Label htmlFor="displayName">{t('queues.display_name')}</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={t('queues.display_name_placeholder')}
              data-testid="queue-display-name-input"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{t('queues.description')}</Label>
            <Textarea
              id="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('queues.description_placeholder')}
              rows={2}
              data-testid="queue-description-input"
            />
          </div>

          {/* Visibility */}
          <div className="space-y-2">
            <Label>{t('queues.visibility')}</Label>
            <Select value={visibility} onValueChange={v => setVisibility(v as QueueVisibility)}>
              <SelectTrigger data-testid="queue-visibility-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">{t('queues.visibility_private')}</SelectItem>
                <SelectItem value="public">{t('queues.visibility_public')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Auto-Process Toggle */}
          <div className="flex items-center justify-between">
            <Label htmlFor="auto-process-toggle">{t('queues.auto_process_enabled')}</Label>
            <Switch
              id="auto-process-toggle"
              checked={autoProcessEnabled}
              onCheckedChange={setAutoProcessEnabled}
              data-testid="auto-process-toggle"
            />
          </div>

          {/* Auto-Process Configuration (shown when enabled) */}
          {autoProcessEnabled && (
            <>
              {/* Processing Mode */}
              <div className="space-y-2">
                <Label>{t('queues.auto_process_mode_label')}</Label>
                <Select
                  value={processMode}
                  onValueChange={v => setProcessMode(v as ProcessMode)}
                  data-testid="process-mode-select"
                >
                  <SelectTrigger data-testid="queue-process-mode-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="direct_agent">
                      {t('queues.auto_process_mode_direct_agent')}
                    </SelectItem>
                    <SelectItem value="subscription">
                      {t('queues.auto_process_mode_subscription')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Subscription Selector – shown only in subscription mode */}
              {processMode === 'subscription' && (
                <div className="space-y-2">
                  <Label>{t('queues.auto_process_subscription')}</Label>
                  {loadingSubscriptions ? (
                    <div className="text-sm text-text-secondary">{t('common:actions.loading')}</div>
                  ) : subscriptions.length === 0 ? (
                    <div className="text-sm text-text-secondary">
                      {t('queues.no_inbox_subscriptions')}
                    </div>
                  ) : (
                    <Select
                      value={selectedSubscriptionId}
                      onValueChange={setSelectedSubscriptionId}
                    >
                      <SelectTrigger data-testid="subscription-select">
                        <SelectValue placeholder={t('queues.select_subscription_placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {subscriptions.map(sub => (
                          <SelectItem key={sub.id} value={String(sub.id)}>
                            {sub.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {/* Team Selector – shown only in direct_agent mode, uses shared TeamContext */}
              {processMode === 'direct_agent' && (
                <div className="space-y-2">
                  <Label>{t('queues.auto_process_team')}</Label>
                  <SearchableSelect
                    value={selectedTeamId}
                    onValueChange={setSelectedTeamId}
                    items={teamSelectItems}
                    loading={loadingTeams}
                    placeholder={t('queues.select_team_placeholder')}
                    searchPlaceholder={t('common:teams.search_team')}
                    emptyText={t('queues.no_teams_available')}
                    noMatchText={t('common:teams.no_match')}
                    triggerClassName="w-full"
                    contentClassName="max-w-[320px]"
                  />
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? t('common:actions.loading') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
