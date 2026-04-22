// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  Inbox,
  Plus,
  Star,
  MoreHorizontal,
  Edit,
  Trash2,
  CheckCircle,
  LayoutTemplate,
  PenLine,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { cn } from '@/lib/utils'
import { useInboxContext } from '../contexts/inboxContext'
import { TemplateSelectDialog } from '@/features/templates'
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
  const { queues, queuesLoading, selectedQueueId, setSelectedQueueId, unreadCount, refreshQueues } =
    useInboxContext()
  const [hoveredQueueId, setHoveredQueueId] = useState<number | null>(null)
  const [openQueueMenuId, setOpenQueueMenuId] = useState<number | null>(null)
  const [choiceDialogOpen, setChoiceDialogOpen] = useState(false)
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)

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
          onClick={() => setChoiceDialogOpen(true)}
          data-testid="create-queue-button"
          title={t('queues.create')}
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
            <Button variant="outline" size="sm" onClick={() => setChoiceDialogOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('queues.create')}
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            {queues.map(queue => {
              const isSelected = queue.id === selectedQueueId
              const isHovered = queue.id === hoveredQueueId
              const isMenuOpen = queue.id === openQueueMenuId
              const showMenu = isHovered || isMenuOpen
              const queueUnread = unreadCount?.byQueue?.[queue.id] || 0

              return (
                <div
                  key={queue.id}
                  className={cn(
                    'group relative flex items-center gap-2 rounded-lg py-2 pl-3 cursor-pointer transition-colors',
                    showMenu ? 'pr-11' : 'pr-3',
                    isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-surface text-text-primary'
                  )}
                  onClick={() => {
                    setOpenQueueMenuId(null)
                    setSelectedQueueId(queue.id)
                  }}
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

                  {/* Unread badge */}
                  {queueUnread > 0 && !showMenu && (
                    <div className="flex items-center gap-1">
                      <Badge variant="error" size="sm">
                        {queueUnread}
                      </Badge>
                    </div>
                  )}

                  {/* Actions menu */}
                  <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    <div
                      className={cn(
                        'transition-opacity duration-150',
                        showMenu ? 'opacity-100' : 'pointer-events-none opacity-0'
                      )}
                      onClick={event => event.stopPropagation()}
                      onMouseDown={event => event.stopPropagation()}
                      onPointerDown={event => event.stopPropagation()}
                    >
                      <DropdownMenu
                        onOpenChange={open => {
                          setOpenQueueMenuId(current => {
                            if (open) {
                              return queue.id
                            }

                            return current === queue.id ? null : current
                          })
                        }}
                      >
                        <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-md"
                            data-testid={`queue-menu-trigger-${queue.id}`}
                            onMouseDown={event => event.stopPropagation()}
                            onPointerDown={event => event.stopPropagation()}
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
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Create queue choice dialog */}
      <Dialog open={choiceDialogOpen} onOpenChange={setChoiceDialogOpen}>
        <DialogContent className="max-w-sm" data-testid="create-queue-choice-dialog">
          <DialogHeader>
            <DialogTitle>{t('create_choice.title')}</DialogTitle>
            <DialogDescription>{t('create_choice.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <button
              className="flex items-start gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-surface/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              data-testid="choice-from-template"
              onClick={() => {
                setChoiceDialogOpen(false)
                setTemplateDialogOpen(true)
              }}
            >
              <LayoutTemplate className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {t('create_choice.from_template')}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {t('create_choice.from_template_desc')}
                </p>
              </div>
            </button>
            <button
              className="flex items-start gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-surface/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              data-testid="choice-custom-create"
              onClick={() => {
                setChoiceDialogOpen(false)
                onCreateQueue()
              }}
            >
              <PenLine className="mt-0.5 h-5 w-5 flex-shrink-0 text-text-secondary" />
              <div>
                <p className="text-sm font-medium text-text-primary">{t('create_choice.custom')}</p>
                <p className="mt-0.5 text-xs text-text-muted">{t('create_choice.custom_desc')}</p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Template import dialog */}
      <TemplateSelectDialog
        open={templateDialogOpen}
        onOpenChange={setTemplateDialogOpen}
        category="inbox"
        onImported={() => {
          refreshQueues()
        }}
      />
    </div>
  )
}
