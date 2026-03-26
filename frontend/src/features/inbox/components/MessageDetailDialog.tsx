// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { User, Clock, MessageSquare, FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatUTCDate } from '@/lib/utils'
import type { QueueMessage, QueueMessageStatus, QueueMessagePriority } from '@/apis/work-queue'
import { cn } from '@/lib/utils'

interface MessageDetailDialogProps {
  message: QueueMessage | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onProcess: (message: QueueMessage) => void
}

const statusLabels: Record<QueueMessageStatus, string> = {
  unread: 'messages.status.unread',
  read: 'messages.status.read',
  processing: 'messages.status.processing',
  processed: 'messages.status.processed',
  archived: 'messages.status.archived',
}

const priorityLabels: Record<QueueMessagePriority, string> = {
  low: 'messages.priority.low',
  normal: 'messages.priority.normal',
  high: 'messages.priority.high',
}

const statusColors: Record<QueueMessageStatus, string> = {
  unread: 'bg-primary/10 text-primary',
  read: 'bg-surface text-text-secondary',
  processing: 'bg-amber-100 text-amber-700',
  processed: 'bg-green-100 text-green-700',
  archived: 'bg-surface text-text-muted',
}

const priorityColors: Record<QueueMessagePriority, string> = {
  low: 'bg-blue-100 text-blue-700',
  normal: 'bg-surface text-text-secondary',
  high: 'bg-red-100 text-red-700',
}

export function MessageDetailDialog({
  message,
  open,
  onOpenChange,
  onProcess,
}: MessageDetailDialogProps) {
  const { t } = useTranslation('inbox')

  if (!message) return null

  const canProcess = message.status !== 'processed' && message.status !== 'processing'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            {t('messages.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Meta information */}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {/* Sender */}
            <div className="flex items-center gap-1.5">
              <User className="h-4 w-4 text-text-muted" />
              <span className="font-medium">{message.sender.userName}</span>
              {message.sender.email && (
                <span className="text-text-muted">({message.sender.email})</span>
              )}
            </div>

            {/* Time */}
            <div className="flex items-center gap-1.5 text-text-muted">
              <Clock className="h-4 w-4" />
              <span>{formatUTCDate(message.createdAt)}</span>
            </div>

            {/* Status */}
            <Badge className={cn('text-xs', statusColors[message.status])}>
              {t(statusLabels[message.status])}
            </Badge>

            {/* Priority */}
            {message.priority !== 'normal' && (
              <Badge className={cn('text-xs', priorityColors[message.priority])}>
                {t(priorityLabels[message.priority])}
              </Badge>
            )}
          </div>

          {/* Note */}
          {message.note && (
            <div className="rounded-lg bg-surface p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium mb-1">
                <FileText className="h-4 w-4" />
                {t('messages.note')}
              </div>
              <p className="text-sm text-text-secondary">{message.note}</p>
            </div>
          )}

          {/* Message content */}
          <div className="border rounded-lg">
            <div className="px-3 py-2 border-b bg-surface/50">
              <span className="text-sm font-medium">
                {t('messages.title')} ({message.contentSnapshot?.length || 0})
              </span>
            </div>
            <ScrollArea className="h-[300px]">
              <div className="p-3 space-y-3">
                {message.contentSnapshot?.map((item, index) => {
                  // Support both uppercase (USER) and lowercase (user) role values
                  const isUserRole = item.role?.toUpperCase() === 'USER'
                  return (
                    <div
                      key={index}
                      className={cn(
                        'rounded-lg p-3',
                        isUserRole ? 'bg-primary/5 ml-4' : 'bg-surface mr-4'
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1 text-xs text-text-muted">
                        <span className="font-medium">
                          {isUserRole ? item.senderUserName || 'User' : 'Assistant'}
                        </span>
                        {item.createdAt && <span>· {formatUTCDate(item.createdAt)}</span>}
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{item.content}</p>

                      {/* Attachments */}
                      {item.attachments && item.attachments.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {item.attachments.map((attachment, attIndex) => (
                            <Badge key={attIndex} variant="info" className="text-xs">
                              {attachment.name}
                              {attachment.file_size && (
                                <span className="ml-1 text-text-muted">
                                  ({Math.round(attachment.file_size / 1024)}KB)
                                </span>
                              )}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </div>

          {/* Process result */}
          {message.processResult && (
            <div className="border rounded-lg">
              <div className="px-3 py-2 border-b bg-green-50">
                <span className="text-sm font-medium text-green-700">
                  {t('messages.view_result')}
                </span>
              </div>
              <div className="p-3">
                <pre className="text-xs text-text-secondary overflow-auto max-h-[200px]">
                  {JSON.stringify(message.processResult, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Actions */}
          {canProcess && (
            <div className="flex items-center justify-end pt-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  onProcess(message)
                  onOpenChange(false)
                }}
              >
                {t('messages.process')}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
