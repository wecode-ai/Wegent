// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, User, Users, Inbox, Clock, Send, Loader2, MessageSquare, Bot } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { toast } from 'sonner'
import {
  forwardMessages,
  getRecentContacts,
  getUserPublicQueues,
  listWorkQueues,
  type ForwardRecipient,
  type QueueMessagePriority,
  type RecentContact,
  type PublicQueue,
  type WorkQueue,
} from '@/apis/work-queue'
import type { SearchUser } from '@/types/api'
import { cn } from '@/lib/utils'
import { useUser } from '@/features/common/UserContext'
import { formatDateTime } from '@/utils/dateTime'

/** Message item for selection in forward dialog */
export interface ForwardableMessage {
  /** Subtask ID - unique identifier for the message */
  subtaskId: number
  /** Message type: user or ai */
  type: 'user' | 'ai'
  /** Message content (truncated for display) */
  content: string
  /** Timestamp */
  timestamp: number
  /** Bot name for AI messages */
  botName?: string
  /** Sender name for user messages in group chat */
  senderUserName?: string
}

interface ForwardMessageDialogProps {
  /** Source task ID */
  taskId: number
  /** Optional subtask IDs to forward specific messages (initial selection) */
  subtaskIds?: number[]
  /** All messages in the conversation for selection */
  allMessages?: ForwardableMessage[]
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

type ForwardMode = 'others' | 'self' | 'chat'

export function ForwardMessageDialog({
  taskId,
  subtaskIds,
  allMessages,
  open,
  onOpenChange,
  onSuccess,
}: ForwardMessageDialogProps) {
  const { t } = useTranslation('inbox')
  const router = useRouter()
  const { user } = useUser()

  // Forward mode state
  const [forwardMode, setForwardMode] = useState<ForwardMode>('others')

  // Form state
  const [recipients, setRecipients] = useState<RecipientWithQueue[]>([])
  const [note, setNote] = useState('')
  const [priority, setPriority] = useState<QueueMessagePriority>('normal')
  const [loading, setLoading] = useState(false)

  // Message selection state
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number>>(new Set())

  // Recent contacts
  const [recentContacts, setRecentContacts] = useState<RecentContact[]>([])
  const [recentLoading, setRecentLoading] = useState(false)

  // User queue selection
  const [userQueues, setUserQueues] = useState<Record<number, PublicQueue[]>>({})
  const [userQueuesLoading, setUserQueuesLoading] = useState<number | null>(null)

  // Self queues (for "forward to self" mode)
  const [selfQueues, setSelfQueues] = useState<WorkQueue[]>([])
  const [selfQueuesLoading, setSelfQueuesLoading] = useState(false)
  const [selectedSelfQueueId, setSelectedSelfQueueId] = useState<number | undefined>(undefined)

  // Initialize selected messages when dialog opens
  useEffect(() => {
    if (open) {
      loadRecentContacts()
      loadSelfQueues()
      // Initialize selected messages with the provided subtaskIds
      if (subtaskIds && subtaskIds.length > 0) {
        setSelectedMessageIds(new Set(subtaskIds))
      } else {
        setSelectedMessageIds(new Set())
      }
    } else {
      // Reset form when dialog closes
      setRecipients([])
      setNote('')
      setPriority('normal')
      setForwardMode('others')
      setSelectedSelfQueueId(undefined)
      setSelectedMessageIds(new Set())
    }
  }, [open, subtaskIds])

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

  const loadSelfQueues = async () => {
    setSelfQueuesLoading(true)
    try {
      const response = await listWorkQueues()
      setSelfQueues(response.items)
      // Auto-select default queue
      const defaultQueue = response.items.find(q => q.isDefault)
      if (defaultQueue) {
        setSelectedSelfQueueId(defaultQueue.id)
      } else if (response.items.length > 0) {
        setSelectedSelfQueueId(response.items[0].id)
      }
    } catch (error) {
      console.error('Failed to load self queues:', error)
    } finally {
      setSelfQueuesLoading(false)
    }
  }

  // Load user's public queues when a user is selected
  const loadUserQueues = useCallback(
    async (userId: number) => {
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
    },
    [userQueues]
  )

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
  const handleQueueChange = useCallback(
    (recipientId: number, queueId: number | undefined, queueName: string | undefined) => {
      setRecipients(prev =>
        prev.map(r =>
          r.id === recipientId && r.type === 'user' ? { ...r, queueId, queueName } : r
        )
      )
    },
    []
  )

  // Handle message selection toggle
  const handleToggleMessage = useCallback((subtaskId: number) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev)
      if (next.has(subtaskId)) {
        next.delete(subtaskId)
      } else {
        next.add(subtaskId)
      }
      return next
    })
  }, [])

  // Handle select all messages
  const handleSelectAllMessages = useCallback(() => {
    if (!allMessages) return
    const allIds = allMessages.map(m => m.subtaskId)
    setSelectedMessageIds(new Set(allIds))
  }, [allMessages])

  // Handle deselect all messages
  const handleDeselectAllMessages = useCallback(() => {
    setSelectedMessageIds(new Set())
  }, [])

  // Get the selected subtask IDs array for API calls
  const getSelectedSubtaskIds = useCallback(() => {
    if (selectedMessageIds.size === 0) return undefined
    return Array.from(selectedMessageIds)
  }, [selectedMessageIds])

  // Handle submit for "forward to others" mode
  const handleSubmitToOthers = async () => {
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
        subtaskIds: getSelectedSubtaskIds(),
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

  // Handle submit for "forward to self" mode
  const handleSubmitToSelf = async () => {
    if (!user?.id) {
      toast.error(t('forward.failed'))
      return
    }

    setLoading(true)
    try {
      await forwardMessages({
        sourceTaskId: taskId,
        subtaskIds: getSelectedSubtaskIds(),
        recipients: [
          {
            type: 'user',
            id: user.id,
            queueId: selectedSelfQueueId,
          },
        ],
        note: note || undefined,
        priority,
      })

      toast.success(t('forward.success_to_self'))
      onOpenChange(false)
      onSuccess?.()
    } catch (error) {
      console.error('Failed to forward messages:', error)
      toast.error(t('forward.failed'))
    } finally {
      setLoading(false)
    }
  }

  // Handle "start chat" mode - navigate to chat page with context
  const handleStartChat = () => {
    // Navigate to chat page with forwarded message context
    const params = new URLSearchParams()
    params.set('forwardTaskId', taskId.toString())
    const selectedIds = getSelectedSubtaskIds()
    if (selectedIds && selectedIds.length > 0) {
      params.set('forwardSubtaskIds', selectedIds.join(','))
    }

    onOpenChange(false)
    router.push(`/chat?${params.toString()}`)
  }

  // Truncate message content for display
  const truncateContent = (content: string, maxLength: number = 80) => {
    // Remove markdown prefix if present
    let text = content
    if (text.startsWith('${$$}$')) {
      text = text.substring(6)
    }
    // Truncate
    if (text.length > maxLength) {
      return text.substring(0, maxLength) + '...'
    }
    return text
  }

  // Handle submit based on mode
  const handleSubmit = async () => {
    switch (forwardMode) {
      case 'others':
        await handleSubmitToOthers()
        break
      case 'self':
        await handleSubmitToSelf()
        break
      case 'chat':
        handleStartChat()
        break
    }
  }

  // Check if submit button should be disabled
  const isSubmitDisabled = () => {
    if (loading) return true
    if (forwardMode === 'others' && recipients.length === 0) return true
    if (forwardMode === 'self' && !selectedSelfQueueId) return true
    return false
  }

  // Get submit button text
  const getSubmitButtonText = () => {
    if (loading) {
      return (
        <>
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          {t('forward.sending')}
        </>
      )
    }

    switch (forwardMode) {
      case 'chat':
        return (
          <>
            <MessageSquare className="mr-1.5 h-4 w-4" />
            {t('forward.start_chat')}
          </>
        )
      default:
        return (
          <>
            <Send className="mr-1.5 h-4 w-4" />
            {t('forward.send')}
          </>
        )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t('forward.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-4 py-2 pr-2">
            {/* Forward mode tabs */}
            <Tabs value={forwardMode} onValueChange={v => setForwardMode(v as ForwardMode)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="others" data-testid="forward-mode-others">
                  <Users className="mr-1.5 h-4 w-4" />
                  {t('forward.mode.others')}
                </TabsTrigger>
                <TabsTrigger value="self" data-testid="forward-mode-self">
                  <Inbox className="mr-1.5 h-4 w-4" />
                  {t('forward.mode.self')}
                </TabsTrigger>
                <TabsTrigger value="chat" data-testid="forward-mode-chat">
                  <MessageSquare className="mr-1.5 h-4 w-4" />
                  {t('forward.mode.chat')}
                </TabsTrigger>
              </TabsList>

              {/* Forward to others */}
              <TabsContent value="others" className="space-y-4 mt-4">
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
                                    <span className="text-sm font-medium truncate">
                                      {recipient.name}
                                    </span>
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
                                          handleQueueChange(
                                            recipient.id,
                                            parseInt(value),
                                            queue?.displayName
                                          )
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
              </TabsContent>

              {/* Forward to self queue */}
              <TabsContent value="self" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>{t('forward.select_self_queue')}</Label>
                  {selfQueuesLoading ? (
                    <div className="flex items-center justify-center py-4 text-sm text-text-muted">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('common:actions.loading')}
                    </div>
                  ) : selfQueues.length === 0 ? (
                    <div className="text-sm text-text-muted text-center py-4">
                      {t('forward.no_queues')}
                    </div>
                  ) : (
                    <Select
                      value={selectedSelfQueueId?.toString() || ''}
                      onValueChange={value => setSelectedSelfQueueId(parseInt(value))}
                    >
                      <SelectTrigger data-testid="forward-self-queue-select">
                        <SelectValue placeholder={t('forward.select_queue')} />
                      </SelectTrigger>
                      <SelectContent>
                        {selfQueues.map(queue => (
                          <SelectItem key={queue.id} value={queue.id.toString()}>
                            <div className="flex items-center gap-1.5">
                              <Inbox className="h-4 w-4" />
                              <span>{queue.displayName}</span>
                              {queue.isDefault && (
                                <span className="text-xs text-text-muted">
                                  ({t('queues.default')})
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <p className="text-sm text-text-muted">{t('forward.self_description')}</p>
              </TabsContent>

              {/* Start new chat */}
              <TabsContent value="chat" className="space-y-4 mt-4">
                <div className="text-center py-6">
                  <MessageSquare className="h-12 w-12 mx-auto text-text-muted mb-3" />
                  <p className="text-sm text-text-muted">{t('forward.chat_description')}</p>
                </div>
              </TabsContent>
            </Tabs>

            {/* Message selection - shown when allMessages is provided */}
            {allMessages && allMessages.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5">
                    <MessageSquare className="h-4 w-4" />
                    {t('forward.select_messages')}
                    <span className="text-text-muted text-xs">
                      ({selectedMessageIds.size}/{allMessages.length})
                    </span>
                  </Label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleSelectAllMessages}
                      disabled={selectedMessageIds.size === allMessages.length}
                      data-testid="forward-select-all"
                    >
                      {t('forward.select_all')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleDeselectAllMessages}
                      disabled={selectedMessageIds.size === 0}
                      data-testid="forward-deselect-all"
                    >
                      {t('forward.deselect_all')}
                    </Button>
                  </div>
                </div>
                <ScrollArea className="h-[200px] border rounded-lg">
                  <div className="p-2 space-y-1">
                    {allMessages.map(msg => {
                      const isSelected = selectedMessageIds.has(msg.subtaskId)
                      return (
                        <div
                          key={msg.subtaskId}
                          className={cn(
                            'flex items-start gap-2 p-2 rounded-md cursor-pointer transition-colors',
                            isSelected
                              ? 'bg-primary/10 border border-primary/30'
                              : 'hover:bg-surface/50'
                          )}
                          onClick={() => handleToggleMessage(msg.subtaskId)}
                          data-testid={`forward-message-${msg.subtaskId}`}
                        >
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => handleToggleMessage(msg.subtaskId)}
                            onClick={e => e.stopPropagation()}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              {msg.type === 'ai' ? (
                                <Bot className="h-3 w-3 text-primary flex-shrink-0" />
                              ) : (
                                <User className="h-3 w-3 text-text-muted flex-shrink-0" />
                              )}
                              <span className="text-xs font-medium text-text-muted">
                                {msg.type === 'ai'
                                  ? msg.botName || t('common:messages.bot')
                                  : msg.senderUserName || t('common:messages.you')}
                              </span>
                              <span className="text-xs text-text-muted">
                                {formatDateTime(msg.timestamp)}
                              </span>
                            </div>
                            <p className="text-sm text-text-primary line-clamp-2">
                              {truncateContent(msg.content)}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              </div>
            )}

            {/* Note - shown for all modes except chat */}
            {forwardMode !== 'chat' && (
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
            )}

            {/* Priority - shown for all modes except chat */}
            {forwardMode !== 'chat' && (
              <div className="space-y-2">
                <Label>{t('forward.priority')}</Label>
                <Select
                  value={priority}
                  onValueChange={v => setPriority(v as QueueMessagePriority)}
                >
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
            )}
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSubmitDisabled()}
            data-testid="forward-send-button"
          >
            {getSubmitButtonText()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
