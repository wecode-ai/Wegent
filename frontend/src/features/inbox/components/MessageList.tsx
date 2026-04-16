// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useMemo } from 'react'
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  Archive,
  MoreHorizontal,
  Eye,
  EyeOff,
  Trash2,
  ArrowUpCircle,
  ArrowRightCircle,
  ArrowDownCircle,
  Play,
  CheckSquare,
  X,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { useInboxContext } from '../contexts/inboxContext'
import { triggerInboxUnreadRefresh } from '../hooks'
import { formatUTCDate } from '@/lib/utils'
import { toast } from 'sonner'
import {
  updateMessageStatus,
  updateMessagePriority,
  deleteQueueMessage,
  batchUpdateMessageStatus,
  batchDeleteMessages,
  retryMessage,
  type QueueMessage,
  type QueueMessageStatus,
  type QueueMessagePriority,
} from '@/apis/work-queue'

interface MessageListProps {
  onViewMessage: (message: QueueMessage) => void
  onProcessMessage: (message: QueueMessage) => void
  onBatchProcessMessages?: (messageIds: number[]) => void
}

const statusConfig: Record<QueueMessageStatus, { icon: React.ReactNode; color: string }> = {
  unread: { icon: <Circle className="h-3 w-3 fill-primary text-primary" />, color: 'text-primary' },
  read: { icon: <Circle className="h-3 w-3" />, color: 'text-text-muted' },
  processing: { icon: <Loader2 className="h-3 w-3 animate-spin" />, color: 'text-amber-500' },
  processed: { icon: <CheckCircle2 className="h-3 w-3" />, color: 'text-green-600' },
  failed: { icon: <AlertCircle className="h-3 w-3" />, color: 'text-red-500' },
  archived: { icon: <Archive className="h-3 w-3" />, color: 'text-text-muted' },
}

const priorityConfig: Record<QueueMessagePriority, { icon: React.ReactNode; color: string }> = {
  high: { icon: <ArrowUpCircle className="h-4 w-4" />, color: 'text-red-500' },
  normal: { icon: <ArrowRightCircle className="h-4 w-4" />, color: 'text-text-muted' },
  low: { icon: <ArrowDownCircle className="h-4 w-4" />, color: 'text-blue-500' },
}

export function MessageList({
  onViewMessage,
  onProcessMessage,
  onBatchProcessMessages,
}: MessageListProps) {
  const { t } = useTranslation('inbox')
  const {
    messages,
    messagesLoading,
    messagesTotal,
    refreshMessages,
    refreshQueues,
    refreshUnreadCount,
    loadMoreMessages,
    statusFilter,
    setStatusFilter,
    sortOrder,
    setSortOrder,
    selectedQueueId,
    queues,
  } = useInboxContext()

  const [actionLoading, setActionLoading] = useState<number | null>(null)
  const [deleteConfirmMessage, setDeleteConfirmMessage] = useState<QueueMessage | null>(null)

  // Multi-select state
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [batchActionLoading, setBatchActionLoading] = useState(false)
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)

  const selectedQueue = queues.find(q => q.id === selectedQueueId)

  // Calculate selection state
  const allSelected = useMemo(() => {
    return messages.length > 0 && messages.every(m => selectedIds.has(m.id))
  }, [messages, selectedIds])

  const someSelected = useMemo(() => {
    return messages.some(m => selectedIds.has(m.id)) && !allSelected
  }, [messages, selectedIds, allSelected])

  // Toggle selection mode
  const toggleSelectionMode = useCallback(() => {
    if (selectionMode) {
      // Exit selection mode and clear selections
      setSelectedIds(new Set())
    }
    setSelectionMode(!selectionMode)
  }, [selectionMode])

  // Toggle single message selection
  const toggleMessageSelection = useCallback((messageId: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(messageId)) {
        newSet.delete(messageId)
      } else {
        newSet.add(messageId)
      }
      return newSet
    })
  }, [])

  // Toggle all messages selection
  const toggleAllSelection = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(messages.map(m => m.id)))
    }
  }, [allSelected, messages])

  // Batch mark as read
  const handleBatchMarkAsRead = useCallback(async () => {
    if (selectedIds.size === 0) return

    setBatchActionLoading(true)
    try {
      const result = await batchUpdateMessageStatus(Array.from(selectedIds), 'read')
      await Promise.all([refreshMessages(), refreshQueues(), refreshUnreadCount()])
      // Trigger global refresh for TaskSidebar's unread count
      triggerInboxUnreadRefresh()
      toast.success(t('batch.mark_read_success', { count: result.successCount }))
      setSelectedIds(new Set())
      setSelectionMode(false)
    } catch (error) {
      console.error('Failed to batch mark as read:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setBatchActionLoading(false)
    }
  }, [selectedIds, refreshMessages, refreshQueues, refreshUnreadCount, t])

  // Batch mark as unread
  const handleBatchMarkAsUnread = useCallback(async () => {
    if (selectedIds.size === 0) return

    setBatchActionLoading(true)
    try {
      const result = await batchUpdateMessageStatus(Array.from(selectedIds), 'unread')
      await Promise.all([refreshMessages(), refreshQueues(), refreshUnreadCount()])
      // Trigger global refresh for TaskSidebar's unread count
      triggerInboxUnreadRefresh()
      toast.success(t('batch.mark_unread_success', { count: result.successCount }))
      setSelectedIds(new Set())
      setSelectionMode(false)
    } catch (error) {
      console.error('Failed to batch mark as unread:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setBatchActionLoading(false)
    }
  }, [selectedIds, refreshMessages, refreshQueues, refreshUnreadCount, t])

  // Batch archive
  const handleBatchArchive = useCallback(async () => {
    if (selectedIds.size === 0) return

    setBatchActionLoading(true)
    try {
      const result = await batchUpdateMessageStatus(Array.from(selectedIds), 'archived')
      await Promise.all([refreshMessages(), refreshQueues(), refreshUnreadCount()])
      // Trigger global refresh for TaskSidebar's unread count
      triggerInboxUnreadRefresh()
      toast.success(t('batch.archive_success', { count: result.successCount }))
      setSelectedIds(new Set())
      setSelectionMode(false)
    } catch (error) {
      console.error('Failed to batch archive:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setBatchActionLoading(false)
    }
  }, [selectedIds, refreshMessages, refreshQueues, refreshUnreadCount, t])

  // Batch delete
  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return

    setBatchActionLoading(true)
    try {
      const result = await batchDeleteMessages(Array.from(selectedIds))
      await Promise.all([refreshMessages(), refreshQueues(), refreshUnreadCount()])
      // Trigger global refresh for TaskSidebar's unread count
      triggerInboxUnreadRefresh()
      toast.success(t('batch.delete_success', { count: result.successCount }))
      setSelectedIds(new Set())
      setSelectionMode(false)
    } catch (error) {
      console.error('Failed to batch delete:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setBatchActionLoading(false)
      setBatchDeleteConfirmOpen(false)
    }
  }, [selectedIds, refreshMessages, refreshQueues, refreshUnreadCount, t])

  const handleStatusChange = async (message: QueueMessage, newStatus: QueueMessageStatus) => {
    setActionLoading(message.id)
    try {
      await updateMessageStatus(message.id, newStatus)
      await refreshMessages()
      // Trigger global refresh for TaskSidebar's unread count when status changes
      triggerInboxUnreadRefresh()
      toast.success(t(`messages.status.${newStatus}`))
    } catch (error) {
      console.error('Failed to update message status:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setActionLoading(null)
    }
  }

  const handlePriorityChange = async (message: QueueMessage, newPriority: QueueMessagePriority) => {
    setActionLoading(message.id)
    try {
      await updateMessagePriority(message.id, newPriority)
      await refreshMessages()
      toast.success(t(`messages.priority.${newPriority}`))
    } catch (error) {
      console.error('Failed to update message priority:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirmMessage) return

    setActionLoading(deleteConfirmMessage.id)
    try {
      await deleteQueueMessage(deleteConfirmMessage.id)
      await refreshMessages()
      toast.success(t('common:actions.delete_success'))
    } catch (error) {
      console.error('Failed to delete message:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setActionLoading(null)
      setDeleteConfirmMessage(null)
    }
  }

  const handleRetry = async (message: QueueMessage) => {
    setActionLoading(message.id)
    try {
      await retryMessage(message.id)
      await refreshMessages()
      toast.success(t('messages.retry_success'))
    } catch (error) {
      console.error('Failed to retry message:', error)
      toast.error(t('common:errors.generic'))
    } finally {
      setActionLoading(null)
    }
  }

  const getMessagePreview = (message: QueueMessage): string => {
    const snapshot = message.contentSnapshot
    if (!snapshot || snapshot.length === 0) return ''
    // Get the last user message
    const lastUserMessage = [...snapshot].reverse().find(m => m.role === 'USER')
    if (lastUserMessage && lastUserMessage.content) {
      return lastUserMessage.content.substring(0, 200)
    }
    const firstContent = snapshot[0]?.content
    return firstContent ? firstContent.substring(0, 200) : ''
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {selectionMode ? (
            <>
              <Checkbox
                checked={allSelected}
                ref={node => {
                  if (node) {
                    // Set indeterminate state for partial selection
                    const input = node.querySelector('input')
                    if (input) {
                      input.indeterminate = someSelected
                    }
                  }
                }}
                onCheckedChange={toggleAllSelection}
                data-testid="select-all-checkbox"
              />
              <span className="text-sm text-text-muted">
                {t('batch.selected', { count: selectedIds.size })}
              </span>
            </>
          ) : (
            <>
              <h3 className="font-medium">{selectedQueue?.displayName || t('messages.title')}</h3>
              {messagesTotal > 0 && (
                <span className="text-sm text-text-muted">({messagesTotal})</span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selectionMode ? (
            <>
              {/* Batch actions */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBatchMarkAsRead}
                disabled={selectedIds.size === 0 || batchActionLoading}
                data-testid="batch-mark-read"
              >
                <Eye className="mr-1 h-4 w-4" />
                {t('batch.mark_read')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBatchMarkAsUnread}
                disabled={selectedIds.size === 0 || batchActionLoading}
                data-testid="batch-mark-unread"
              >
                <EyeOff className="mr-1 h-4 w-4" />
                {t('batch.mark_unread')}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleBatchArchive}
                  disabled={selectedIds.size === 0 || batchActionLoading}
                  data-testid="batch-archive"
                >
                  <Archive className="mr-1 h-4 w-4" />
                  {t('batch.archive')}
                </Button>
                {onBatchProcessMessages && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onBatchProcessMessages(Array.from(selectedIds))}
                    disabled={selectedIds.size === 0 || batchActionLoading}
                    className="text-primary hover:text-primary"
                    data-testid="batch-process"
                  >
                    <Play className="mr-1 h-4 w-4" />
                    {t('batch.process')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBatchDeleteConfirmOpen(true)}
                  disabled={selectedIds.size === 0 || batchActionLoading}
                  className="text-destructive hover:text-destructive"
                  data-testid="batch-delete"
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  {t('batch.delete')}
                </Button>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSelectionMode}
                data-testid="exit-selection-mode"
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              {/* Selection mode toggle */}
              {messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleSelectionMode}
                  data-testid="enter-selection-mode"
                >
                  <CheckSquare className="mr-1 h-4 w-4" />
                  {t('batch.select')}
                </Button>
              )}

              {/* Status filter */}
              <Select
                value={statusFilter}
                onValueChange={value => setStatusFilter(value as QueueMessageStatus | 'all')}
              >
                <SelectTrigger className="h-8 w-[120px]" data-testid="status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('messages.filter.all')}</SelectItem>
                  <SelectItem value="unread">{t('messages.filter.unread')}</SelectItem>
                  <SelectItem value="read">{t('messages.filter.read')}</SelectItem>
                  <SelectItem value="processing">{t('messages.filter.processing')}</SelectItem>
                  <SelectItem value="processed">{t('messages.filter.processed')}</SelectItem>
                  <SelectItem value="archived">{t('messages.filter.archived')}</SelectItem>
                </SelectContent>
              </Select>

              {/* Sort order */}
              <Select
                value={sortOrder}
                onValueChange={value => setSortOrder(value as 'asc' | 'desc')}
              >
                <SelectTrigger className="h-8 w-[120px]" data-testid="sort-order">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">{t('messages.sort.newest')}</SelectItem>
                  <SelectItem value="asc">{t('messages.sort.oldest')}</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto">
        {messagesLoading && messages.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-text-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('common:actions.loading')}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-sm text-text-muted">
            <p>{t('messages.empty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {messages.map(message => {
              const status = statusConfig[message.status]
              const priority = priorityConfig[message.priority]
              const preview = getMessagePreview(message)

              const isSelected = selectedIds.has(message.id)

              return (
                <div
                  key={message.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3 hover:bg-surface/50 cursor-pointer transition-colors',
                    message.status === 'unread' && 'bg-primary/5',
                    isSelected && 'bg-primary/10'
                  )}
                  onClick={
                    selectionMode
                      ? e => toggleMessageSelection(message.id, e)
                      : () => onViewMessage(message)
                  }
                  data-testid={`message-item-${message.id}`}
                >
                  {/* Checkbox or Status indicator */}
                  {selectionMode ? (
                    <div
                      className="mt-1 flex-shrink-0"
                      onClick={e => toggleMessageSelection(message.id, e)}
                    >
                      <Checkbox
                        checked={isSelected}
                        data-testid={`message-checkbox-${message.id}`}
                      />
                    </div>
                  ) : (
                    <div className={cn('mt-1 flex-shrink-0', status.color)}>{status.icon}</div>
                  )}

                  {/* Message content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{message.sender.userName}</span>
                      <span className="text-xs text-text-muted">
                        {formatUTCDate(message.createdAt)}
                      </span>
                      {message.priority !== 'normal' && (
                        <span className={priority.color}>{priority.icon}</span>
                      )}
                    </div>
                    {message.note && (
                      <div className="flex items-center gap-1 mt-1">
                        <Badge variant="info" className="text-xs">
                          {t('messages.note')}: {message.note}
                        </Badge>
                      </div>
                    )}
                    <p className="text-sm text-text-secondary mt-1 line-clamp-2">{preview}</p>
                    {/* Failed message error display */}
                    {message.status === 'failed' && message.processResult?.error != null && (
                      <div className="flex items-center gap-1 mt-1">
                        <Badge variant="error" className="text-xs">
                          {t('messages.process_error')}: {String(message.processResult.error)}
                        </Badge>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-xs text-text-muted">
                      <span>
                        {message.contentSnapshot?.length || 0} {t('chat:message_count')}
                      </span>
                      {message.processedAt && (
                        <>
                          <span>·</span>
                          <span>
                            {t('messages.processed_at')}: {formatUTCDate(message.processedAt)}
                          </span>
                        </>
                      )}
                      {/* View Conversation link for direct_agent processed messages */}
                      {message.processTaskId != null && message.processTaskId > 0 && (
                        <>
                          <span>·</span>
                          <a
                            href={`/chat?task_id=${message.processTaskId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-0.5 text-primary hover:underline"
                            onClick={e => e.stopPropagation()}
                            data-testid={`view-task-link-${message.id}`}
                          >
                            <ExternalLink className="h-3 w-3" />
                            {t('messages.view_task')}
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={actionLoading === message.id}
                        >
                          {actionLoading === message.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <MoreHorizontal className="h-4 w-4" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {/* Process action */}
                        {message.status !== 'processed' &&
                          message.status !== 'processing' &&
                          message.status !== 'failed' && (
                            <DropdownMenuItem onClick={() => onProcessMessage(message)}>
                              <Play className="mr-2 h-4 w-4" />
                              {t('messages.process')}
                            </DropdownMenuItem>
                          )}

                        {/* Retry action for failed messages */}
                        {message.status === 'failed' && (
                          <DropdownMenuItem
                            onClick={() => handleRetry(message)}
                            data-testid="retry-message-button"
                          >
                            <RefreshCw className="mr-2 h-4 w-4" />
                            {t('messages.retry')}
                          </DropdownMenuItem>
                        )}

                        {/* Status actions */}
                        {message.status === 'unread' ? (
                          <DropdownMenuItem onClick={() => handleStatusChange(message, 'read')}>
                            <Eye className="mr-2 h-4 w-4" />
                            {t('messages.mark_as_read')}
                          </DropdownMenuItem>
                        ) : message.status === 'read' ? (
                          <DropdownMenuItem onClick={() => handleStatusChange(message, 'unread')}>
                            <EyeOff className="mr-2 h-4 w-4" />
                            {t('messages.mark_as_unread')}
                          </DropdownMenuItem>
                        ) : null}

                        {message.status !== 'archived' && (
                          <DropdownMenuItem onClick={() => handleStatusChange(message, 'archived')}>
                            <Archive className="mr-2 h-4 w-4" />
                            {t('messages.archive')}
                          </DropdownMenuItem>
                        )}

                        {/* Priority submenu */}
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <ArrowRightCircle className="mr-2 h-4 w-4" />
                            {t('messages.set_priority')}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem onClick={() => handlePriorityChange(message, 'high')}>
                              <ArrowUpCircle className="mr-2 h-4 w-4 text-red-500" />
                              {t('messages.priority.high')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handlePriorityChange(message, 'normal')}
                            >
                              <ArrowRightCircle className="mr-2 h-4 w-4" />
                              {t('messages.priority.normal')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handlePriorityChange(message, 'low')}>
                              <ArrowDownCircle className="mr-2 h-4 w-4 text-blue-500" />
                              {t('messages.priority.low')}
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>

                        <DropdownMenuSeparator />

                        {/* Delete */}
                        <DropdownMenuItem
                          onClick={() => setDeleteConfirmMessage(message)}
                          className="text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {t('messages.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })}

            {/* Load more */}
            {messages.length < messagesTotal && (
              <div className="flex justify-center py-4">
                <Button variant="ghost" onClick={loadMoreMessages} disabled={messagesLoading}>
                  {messagesLoading ? t('common:actions.loading') : t('common:tasks.load_more')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteConfirmMessage}
        onOpenChange={open => !open && setDeleteConfirmMessage(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('messages.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('messages.delete_confirm_message')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch delete confirmation dialog */}
      <AlertDialog open={batchDeleteConfirmOpen} onOpenChange={setBatchDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('batch.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('batch.delete_confirm_message', { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={batchActionLoading}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBatchDelete}
              disabled={batchActionLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {batchActionLoading ? t('common:actions.loading') : t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
