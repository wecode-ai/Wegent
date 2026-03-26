// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Inbox, Plus, Star, MoreHorizontal, Edit, Trash2, CheckCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { cn } from '@/lib/utils'
import { useInboxContext } from '../contexts/inboxContext'
import type { WorkQueue } from '@/apis/work-queue'

interface QueueSidebarProps {
  onCreateQueue: () => void
  onEditQueue: (queue: WorkQueue) => void
  onDeleteQueue: (queue: WorkQueue) => void
  onSetDefault: (queue: WorkQueue) => void
}

export function QueueSidebar({
  onCreateQueue,
  onEditQueue,
  onDeleteQueue,
  onSetDefault,
}: QueueSidebarProps) {
  const { t } = useTranslation('inbox')
  const { queues, queuesLoading, selectedQueueId, setSelectedQueueId, unreadCount } =
    useInboxContext()
  const [hoveredQueueId, setHoveredQueueId] = useState<number | null>(null)

  const totalUnread = unreadCount?.total || 0

  return (
    <div className="flex h-full flex-col bg-surface/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-primary" />
          <h2 className="font-semibold">{t('title')}</h2>
          {totalUnread > 0 && (
            <Badge variant="error" size="sm">
              {totalUnread}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onCreateQueue}
          data-testid="create-queue-button"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Queue List */}
      <div className="flex-1 overflow-y-auto p-2">
        {queuesLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-text-muted">
            {t('common:actions.loading')}
          </div>
        ) : queues.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-text-muted">
            <p>{t('empty')}</p>
            <Button variant="outline" size="sm" onClick={onCreateQueue}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('queues.create')}
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            {queues.map(queue => {
              const isSelected = queue.id === selectedQueueId
              const isHovered = queue.id === hoveredQueueId
              const queueUnread = unreadCount?.byQueue?.[queue.id] || 0

              return (
                <div
                  key={queue.id}
                  className={cn(
                    'group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors',
                    isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-surface text-text-primary'
                  )}
                  onClick={() => setSelectedQueueId(queue.id)}
                  onMouseEnter={() => setHoveredQueueId(queue.id)}
                  onMouseLeave={() => setHoveredQueueId(null)}
                  data-testid={`queue-item-${queue.id}`}
                >
                  {/* Queue icon */}
                  <div className="flex-shrink-0">
                    {queue.isDefault ? (
                      <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
                    ) : (
                      <Inbox className="h-4 w-4" />
                    )}
                  </div>

                  {/* Queue name */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{queue.displayName}</span>
                    </div>
                    {queue.description && (
                      <p className="truncate text-xs text-text-muted">{queue.description}</p>
                    )}
                  </div>

                  {/* Unread badge or actions */}
                  <div className="flex items-center gap-1">
                    {queueUnread > 0 && !isHovered && (
                      <Badge variant="error" size="sm">
                        {queueUnread}
                      </Badge>
                    )}
                    {(isHovered || isSelected) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                          <DropdownMenuItem onClick={() => onEditQueue(queue)}>
                            <Edit className="mr-2 h-4 w-4" />
                            {t('queues.edit')}
                          </DropdownMenuItem>
                          {!queue.isDefault && (
                            <DropdownMenuItem onClick={() => onSetDefault(queue)}>
                              <CheckCircle className="mr-2 h-4 w-4" />
                              {t('queues.set_as_default')}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDeleteQueue(queue)}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('queues.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
