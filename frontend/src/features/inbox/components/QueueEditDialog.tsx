// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
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
} from '@/apis/work-queue'
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
  const [autoProcessEnabled, setAutoProcessEnabled] = useState(false)
  const [triggerMode, setTriggerMode] = useState<TriggerMode>('manual')
  const [scheduleInterval, setScheduleInterval] = useState(30)
  const [replyToSender, setReplyToSender] = useState(false)
  const [saveInQueue, setSaveInQueue] = useState(true)
  const [sendNotification, setSendNotification] = useState(false)

  const [loading, setLoading] = useState(false)

  // Reset form when dialog opens/closes or queue changes
  useEffect(() => {
    if (open && queue) {
      setName(queue.name)
      setDisplayName(queue.displayName)
      setDescription(queue.description || '')
      setVisibility(queue.visibility)
      setAutoProcessEnabled(queue.autoProcess?.enabled || false)
      setTriggerMode(queue.autoProcess?.triggerMode || 'manual')
      setScheduleInterval(queue.autoProcess?.scheduleInterval || 30)
      setReplyToSender(queue.resultFeedback?.replyToSender || false)
      setSaveInQueue(queue.resultFeedback?.saveInQueue ?? true)
      setSendNotification(queue.resultFeedback?.sendNotification || false)
    } else if (open && !queue) {
      // Reset to defaults for new queue
      setName('')
      setDisplayName('')
      setDescription('')
      setVisibility('private')
      setAutoProcessEnabled(false)
      setTriggerMode('manual')
      setScheduleInterval(30)
      setReplyToSender(false)
      setSaveInQueue(true)
      setSendNotification(false)
    }
  }, [open, queue])

  const handleSubmit = async () => {
    if (!displayName.trim()) {
      toast.error(t('queues.display_name_placeholder'))
      return
    }

    if (!isEditing && !name.trim()) {
      toast.error(t('queues.name_placeholder'))
      return
    }

    setLoading(true)
    try {
      if (isEditing && queue) {
        const updateData: WorkQueueUpdateRequest = {
          displayName,
          description: description || undefined,
          visibility,
          autoProcess: autoProcessEnabled
            ? {
                enabled: true,
                triggerMode,
                scheduleInterval: triggerMode === 'scheduled' ? scheduleInterval : undefined,
              }
            : { enabled: false, triggerMode: 'manual' },
          resultFeedback: {
            replyToSender,
            saveInQueue,
            sendNotification,
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
          autoProcess: autoProcessEnabled
            ? {
                enabled: true,
                triggerMode,
                scheduleInterval: triggerMode === 'scheduled' ? scheduleInterval : undefined,
              }
            : undefined,
          resultFeedback: {
            replyToSender,
            saveInQueue,
            sendNotification,
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
          <DialogTitle>
            {isEditing ? t('queues.edit') : t('queues.create')}
          </DialogTitle>
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
                <SelectItem value="group_visible">{t('queues.visibility_group_visible')}</SelectItem>
                <SelectItem value="invite_only">{t('queues.visibility_invite_only')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Auto process */}
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="autoProcess">{t('queues.auto_process')}</Label>
              <Switch
                id="autoProcess"
                checked={autoProcessEnabled}
                onCheckedChange={setAutoProcessEnabled}
                data-testid="queue-auto-process-switch"
              />
            </div>

            {autoProcessEnabled && (
              <div className="space-y-3 pt-2">
                <div className="space-y-2">
                  <Label>{t('queues.trigger_mode')}</Label>
                  <Select
                    value={triggerMode}
                    onValueChange={v => setTriggerMode(v as TriggerMode)}
                  >
                    <SelectTrigger data-testid="queue-trigger-mode-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="immediate">{t('queues.trigger_immediate')}</SelectItem>
                      <SelectItem value="manual">{t('queues.trigger_manual')}</SelectItem>
                      <SelectItem value="scheduled">{t('queues.trigger_scheduled')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {triggerMode === 'scheduled' && (
                  <div className="space-y-2">
                    <Label htmlFor="interval">{t('queues.schedule_interval')}</Label>
                    <Input
                      id="interval"
                      type="number"
                      min={15}
                      value={scheduleInterval}
                      onChange={e => {
                        const val = parseInt(e.target.value, 10)
                        if (!isNaN(val)) setScheduleInterval(val)
                      }}
                      data-testid="queue-schedule-interval-input"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Result feedback */}
          <div className="space-y-3 rounded-lg border p-3">
            <Label>{t('queues.result_feedback')}</Label>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('queues.reply_to_sender')}</span>
                <Switch
                  checked={replyToSender}
                  onCheckedChange={setReplyToSender}
                  data-testid="queue-reply-sender-switch"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('queues.save_in_queue')}</span>
                <Switch
                  checked={saveInQueue}
                  onCheckedChange={setSaveInQueue}
                  data-testid="queue-save-queue-switch"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('queues.send_notification')}</span>
                <Switch
                  checked={sendNotification}
                  onCheckedChange={setSendNotification}
                  data-testid="queue-send-notification-switch"
                />
              </div>
            </div>
          </div>
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
