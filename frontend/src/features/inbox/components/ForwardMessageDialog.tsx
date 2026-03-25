// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, User, Users, Inbox, Clock, Send, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { toast } from 'sonner'
import {
  forwardMessages,
  getRecentContacts,
  getUserPublicQueues,
  type ForwardRecipient,
  type QueueMessagePriority,
  type RecentContact,
  type PublicQueue,
} from '@/apis/work-queue'
import type { SearchUser } from '@/types/api'
import { cn } from '@/lib/utils'

interface ForwardMessageDialogProps {
  /** Source task ID */
  taskId: number
  /** Optional subtask IDs to forward specific messages */
  subtaskIds?: number[]
  /** Whether the dialog is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when forward is successful */
  onSuccess?: () => void
}

interface RecipientWithQueue {
  type: 'user' | 'group'
  id: number
  name: string
  email?: string
  queueId?: number
  queueName?: string
}

export function ForwardMessageDialog({
  taskId,
  subtaskIds,
  open,
  onOpenChange,
  onSuccess,
}: ForwardMessageDialogProps) {
  const { t } = useTranslation('inbox')

  // Form state
  const [recipients, setRecipients] = useState<RecipientWithQueue[]>([])
  const [note, setNote] = useState('')
  const [priority, setPriority] = useState<QueueMessagePriority>('normal')
  const [loading, setLoading] = useState(false)

  // Recent contacts
  const [recentContacts, setRecentContacts] = useState<RecentContact[]>([])
  const [recentLoading, setRecentLoading] = useState(false)

  // User queue selection
  const [userQueues, setUserQueues] = useState<Record<number, PublicQueue[]>>({})
  const [userQueuesLoading, setUserQueuesLoading] = useState<number | null>(null)

  // Load recent contacts when dialog opens
  useEffect(() => {
    if (open) {
      loadRecentContacts()
    } else {
      // Reset form when dialog closes
      setRecipients([])
      setNote('')
      setPriority('normal')
    }
  }, [open])

  const loadRecentContacts = async () => {
    setRecentLoading(true)
    try {
      const response = await getRecentContacts(10)
      setRecentContacts(response.items)
    } catch (error) {
      console.error('Failed to load recent contacts:', error)
    } finally {
      setRecentLoading(false)
    }
  }

  // Load user's public queues when a user is selected
  const loadUserQueues = useCallback(async (userId: number) => {
    if (userQueues[userId]) return // Already loaded

    setUserQueuesLoading(userId)
    try {
      const response = await getUserPublicQueues(userId)
      setUserQueues(prev => ({
        ...prev,
        [userId]: response.queues,
      }))
    } catch (error) {
      console.error('Failed to load user queues:', error)
      setUserQueues(prev => ({
        ...prev,
        [userId]: [],
      }))
    } finally {
      setUserQueuesLoading(null)
    }
  }, [userQueues])

  // Handle adding a recipient from search
  const handleAddRecipient = useCallback(
    (users: SearchUser[]) => {
      const newRecipients: RecipientWithQueue[] = users.map(user => ({
        type: 'user' as const,
        id: user.id,
        name: user.user_name,
        email: user.email,
      }))

      // Add only new recipients
      const existingIds = new Set(recipients.map(r => `${r.type}-${r.id}`))
      const toAdd = newRecipients.filter(r => !existingIds.has(`${r.type}-${r.id}`))

      if (toAdd.length > 0) {
        setRecipients(prev => [...prev, ...toAdd])
        // Load queues for new users
        toAdd.forEach(r => {
          if (r.type === 'user') {
            loadUserQueues(r.id)
          }
        })
      }
    },
    [recipients, loadUserQueues]
  )

  // Handle adding a recent contact
  const handleAddRecentContact = useCallback(
    (contact: RecentContact) => {
      const existingIds = new Set(recipients.map(r => `${r.type}-${r.id}`))
      if (existingIds.has(`user-${contact.userId}`)) return

      setRecipients(prev => [
        ...prev,
        {
          type: 'user',
          id: contact.userId,
          name: contact.userName,
          email: contact.email,
        },
      ])
      loadUserQueues(contact.userId)
    },
    [recipients, loadUserQueues]
  )

  // Handle removing a recipient
  const handleRemoveRecipient = useCallback((type: string, id: number) => {
    setRecipients(prev => prev.filter(r => !(r.type === type && r.id === id)))
  }, [])

  // Handle queue selection for a recipient
  const handleQueueChange = useCallback((recipientId: number, queueId: number | undefined, queueName: string | undefined) => {
    setRecipients(prev =>
      prev.map(r =>
        r.id === recipientId && r.type === 'user'
          ? { ...r, queueId, queueName }
          : r
      )
    )
  }, [])

  // Handle submit
  const handleSubmit = async () => {
    if (recipients.length === 0) {
      toast.error(t('forward.no_recipients'))
      return
    }

    setLoading(true)
    try {
      const forwardRecipients: ForwardRecipient[] = recipients.map(r => ({
        type: r.type,
        id: r.id,
        queueId: r.queueId,
      }))

      await forwardMessages({
        sourceTaskId: taskId,
        subtaskIds,
        recipients: forwardRecipients,
        note: note || undefined,
        priority,
      })

      toast.success(t('forward.success'))
      onOpenChange(false)
      onSuccess?.()
    } catch (error) {
      console.error('Failed to forward messages:', error)
      toast.error(t('forward.failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t('forward.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Recipient search */}
          <div className="space-y-2">
            <Label>{t('forward.recipients')}</Label>
            <UserSearchSelect
              selectedUsers={[]}
              onSelectedUsersChange={handleAddRecipient}
              placeholder={t('forward.search_placeholder')}
              hideSelectedUsers
              autoFocus
            />
          </div>

          {/* Selected recipients */}
          {recipients.length > 0 && (
            <div className="space-y-2">
              <ScrollArea className="max-h-[200px]">
                <div className="space-y-2">
                  {recipients.map(recipient => {
                    const queues = userQueues[recipient.id] || []
                    const isLoadingQueues = userQueuesLoading === recipient.id

                    return (
                      <div
                        key={`${recipient.type}-${recipient.id}`}
                        className="flex items-center gap-2 p-2 rounded-lg bg-surface/50"
                      >
                        {/* Recipient info */}
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div className="flex-shrink-0">
                            {recipient.type === 'user' ? (
                              <User className="h-4 w-4 text-text-muted" />
                            ) : (
                              <Users className="h-4 w-4 text-text-muted" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium truncate">{recipient.name}</span>
                            </div>
                            {recipient.email && (
                              <span className="text-xs text-text-muted truncate block">
                                {recipient.email}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Queue selection */}
                        {recipient.type === 'user' && (
                          <div className="flex-shrink-0 w-[140px]">
                            {isLoadingQueues ? (
                              <div className="flex items-center justify-center h-8">
                                <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
                              </div>
                            ) : (
                              <Select
                                value={recipient.queueId?.toString() || 'default'}
                                onValueChange={value => {
                                  if (value === 'default') {
                                    handleQueueChange(recipient.id, undefined, undefined)
                                  } else {
                                    const queue = queues.find(q => q.id.toString() === value)
                                    handleQueueChange(recipient.id, parseInt(value), queue?.displayName)
                                  }
                                }}
                              >
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue placeholder={t('forward.select_queue')} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="default">
                                    <div className="flex items-center gap-1.5">
                                      <Inbox className="h-3 w-3" />
                                      {t('forward.default_queue')}
                                    </div>
                                  </SelectItem>
                                  {queues.map(queue => (
                                    <SelectItem key={queue.id} value={queue.id.toString()}>
                                      <div className="flex items-center gap-1.5">
                                        <Inbox className="h-3 w-3" />
                                        {queue.displayName}
                                      </div>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        )}

                        {/* Remove button */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 flex-shrink-0"
                          onClick={() => handleRemoveRecipient(recipient.type, recipient.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Recent contacts */}
          {recipients.length === 0 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5 text-text-muted">
                <Clock className="h-4 w-4" />
                {t('forward.recent_contacts')}
              </Label>
              {recentLoading ? (
                <div className="flex items-center justify-center py-4 text-sm text-text-muted">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common:actions.loading')}
                </div>
              ) : recentContacts.length === 0 ? (
                <div className="text-sm text-text-muted text-center py-4">
                  {t('common:noData')}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {recentContacts.map(contact => {
                    const isSelected = recipients.some(
                      r => r.type === 'user' && r.id === contact.userId
                    )
                    return (
                      <button
                        type="button"
                        key={contact.id}
                        className={cn(
                          'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors cursor-pointer',
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-info text-info-foreground hover:bg-surface'
                        )}
                        onClick={() => !isSelected && handleAddRecentContact(contact)}
                        disabled={isSelected}
                      >
                        {contact.userName}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Note */}
          <div className="space-y-2">
            <Label htmlFor="note">{t('forward.note')}</Label>
            <Textarea
              id="note"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('forward.note_placeholder')}
              rows={2}
              data-testid="forward-note-input"
            />
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <Label>{t('forward.priority')}</Label>
            <Select value={priority} onValueChange={v => setPriority(v as QueueMessagePriority)}>
              <SelectTrigger data-testid="forward-priority-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{t('messages.priority.low')}</SelectItem>
                <SelectItem value="normal">{t('messages.priority.normal')}</SelectItem>
                <SelectItem value="high">{t('messages.priority.high')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={loading || recipients.length === 0}
            data-testid="forward-send-button"
          >
            {loading ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                {t('forward.sending')}
              </>
            ) : (
              <>
                <Send className="mr-1.5 h-4 w-4" />
                {t('forward.send')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
