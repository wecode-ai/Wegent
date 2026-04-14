// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
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
import { toast } from 'sonner'
import {
  createWorkQueue,
  updateWorkQueue,
  type WorkQueue,
  type WorkQueueCreateRequest,
  type WorkQueueUpdateRequest,
  type QueueVisibility,
  type TriggerMode,
  type SubscriptionRef,
} from '@/apis/work-queue'
import { subscriptionApis } from '@/apis/subscription'
import { useInboxContext } from '../contexts/inboxContext'

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
  const [triggerMode, setTriggerMode] = useState<TriggerMode>('manual')

  // Auto-process state
  const [autoProcessEnabled, setAutoProcessEnabled] = useState(false)
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<string>('')
  const [subscriptions, setSubscriptions] = useState<
    Array<{ id: number; name: string; namespace: string; displayName: string; userId: number }>
  >([])
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false)

  const [loading, setLoading] = useState(false)

  // Fetch subscriptions when auto-process is enabled
  const fetchSubscriptions = useCallback(async () => {
    setLoadingSubscriptions(true)
    try {
      const response = await subscriptionApis.getSubscriptions(
        { page: 1, limit: 100 },
        undefined,
        'event'
      )
      // Filter to inbox_message event type subscriptions
      // API returns flat SubscriptionInDB objects where trigger_config is { event_type: 'inbox_message' }
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
      setTriggerMode(queue.autoProcess?.triggerMode || 'manual')
      setAutoProcessEnabled(queue.autoProcess?.enabled || false)
      // Try to find the subscription by ref
      if (queue.autoProcess?.subscriptionRef) {
        // Will be matched after subscriptions are loaded
        setSelectedSubscriptionId('')
      } else {
        setSelectedSubscriptionId('')
      }
    } else if (open && !queue) {
      // Reset to defaults for new queue
      setName('')
      setDisplayName('')
      setDescription('')
      setVisibility('private')
      setTriggerMode('manual')
      setAutoProcessEnabled(false)
      setSelectedSubscriptionId('')
    }
  }, [open, queue])

  // Fetch subscriptions when dialog opens or auto-process is toggled on
  useEffect(() => {
    if (open && autoProcessEnabled) {
      fetchSubscriptions()
    }
  }, [open, autoProcessEnabled, fetchSubscriptions])

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

  const handleSubmit = async () => {
    if (!displayName.trim()) {
      toast.error(t('queues.display_name_placeholder'))
      return
    }

    if (!isEditing && !name.trim()) {
      toast.error(t('queues.name_placeholder'))
      return
    }

    // Build subscriptionRef from selected subscription
    let subscriptionRef: SubscriptionRef | undefined
    if (autoProcessEnabled && selectedSubscriptionId) {
      const sub = subscriptions.find(s => String(s.id) === selectedSubscriptionId)
      if (sub) {
        subscriptionRef = {
          namespace: sub.namespace,
          name: sub.name,
          userId: sub.userId,
        }
      }
    }

    setLoading(true)
    try {
      if (isEditing && queue) {
        const updateData: WorkQueueUpdateRequest = {
          displayName,
          description: description || undefined,
          visibility,
          autoProcess: {
            enabled: autoProcessEnabled,
            triggerMode,
            subscriptionRef,
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
            triggerMode,
            subscriptionRef,
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
              {/* Trigger Mode */}
              <div className="space-y-2">
                <Label>{t('queues.trigger_mode')}</Label>
                <Select value={triggerMode} onValueChange={v => setTriggerMode(v as TriggerMode)}>
                  <SelectTrigger data-testid="queue-trigger-mode-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="immediate">{t('queues.trigger_immediate')}</SelectItem>
                    <SelectItem value="manual">{t('queues.trigger_manual')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Subscription Selector */}
              <div className="space-y-2">
                <Label>{t('queues.auto_process_subscription')}</Label>
                {loadingSubscriptions ? (
                  <div className="text-sm text-text-secondary">{t('common:actions.loading')}</div>
                ) : subscriptions.length === 0 ? (
                  <div className="text-sm text-text-secondary">
                    {t('queues.no_inbox_subscriptions')}
                  </div>
                ) : (
                  <Select value={selectedSubscriptionId} onValueChange={setSelectedSubscriptionId}>
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
