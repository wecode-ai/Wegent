// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { useDevices } from '@/contexts/DeviceContext'
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
import { toast } from 'sonner'
import { useInboxContext } from '../contexts/inboxContext'
import { triggerInboxUnreadRefresh } from '../hooks'
import { QueueSidebar } from './QueueSidebar'
import { MessageList } from './MessageList'
import { MessageDetailDialog, type InboxProcessMode } from './MessageDetailDialog'
import { QueueEditDialog } from './QueueEditDialog'
import {
  deleteWorkQueue,
  setDefaultQueue,
  updateMessageStatus,
  type WorkQueue,
  type QueueMessage,
} from '@/apis/work-queue'
import { getPreferredExecutionDevice } from '@/features/devices/utils/execution-target'

export function InboxPage() {
  const { t } = useTranslation('inbox')
  const router = useRouter()
  const { devices } = useDevices()
  const { refreshQueues, refreshMessages, refreshUnreadCount } = useInboxContext()

  // Queue edit dialog
  const [editQueueDialogOpen, setEditQueueDialogOpen] = useState(false)
  const [editingQueue, setEditingQueue] = useState<WorkQueue | null>(null)

  // Queue delete confirmation
  const [deleteQueueDialogOpen, setDeleteQueueDialogOpen] = useState(false)
  const [deletingQueue, setDeletingQueue] = useState<WorkQueue | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  // Message detail dialog
  const [messageDetailDialogOpen, setMessageDetailDialogOpen] = useState(false)
  const [selectedMessage, setSelectedMessage] = useState<QueueMessage | null>(null)

  // Handle create queue
  const handleCreateQueue = useCallback(() => {
    setEditingQueue(null)
    setEditQueueDialogOpen(true)
  }, [])

  // Handle edit queue
  const handleEditQueue = useCallback((queue: WorkQueue) => {
    setEditingQueue(queue)
    setEditQueueDialogOpen(true)
  }, [])

  // Handle delete queue
  const handleDeleteQueue = useCallback((queue: WorkQueue) => {
    setDeletingQueue(queue)
    setDeleteQueueDialogOpen(true)
  }, [])

  // Confirm delete queue
  const confirmDeleteQueue = useCallback(async () => {
    if (!deletingQueue) return

    setDeleteLoading(true)
    try {
      await deleteWorkQueue(deletingQueue.id)
      await refreshQueues()
      toast.success(t('queues.delete_success'))
    } catch (error) {
      console.error('Failed to delete queue:', error)
      toast.error(t('queues.delete_failed'))
    } finally {
      setDeleteLoading(false)
      setDeleteQueueDialogOpen(false)
      setDeletingQueue(null)
    }
  }, [deletingQueue, refreshQueues, t])

  // Handle set default queue
  const handleSetDefault = useCallback(
    async (queue: WorkQueue) => {
      try {
        await setDefaultQueue(queue.id)
        await refreshQueues()
        toast.success(t('queues.update_success'))
      } catch (error) {
        console.error('Failed to set default queue:', error)
        toast.error(t('queues.update_failed'))
      }
    },
    [refreshQueues, t]
  )

  // Handle view message - also mark as read if unread
  const handleViewMessage = useCallback(
    async (message: QueueMessage) => {
      setSelectedMessage(message)
      setMessageDetailDialogOpen(true)

      // Auto mark as read when viewing
      if (message.status === 'unread') {
        try {
          await updateMessageStatus(message.id, 'read')
          // Refresh messages, queues, and unread count to update the UI
          await Promise.all([refreshMessages(), refreshQueues(), refreshUnreadCount()])
          // Trigger global refresh for TaskSidebar's unread count
          triggerInboxUnreadRefresh()
        } catch (error) {
          console.error('Failed to mark message as read:', error)
        }
      }
    },
    [refreshMessages, refreshQueues, refreshUnreadCount]
  )

  // Handle process message
  const handleProcessMessage = useCallback(
    (message: QueueMessage, mode: InboxProcessMode = 'chat') => {
      const params = new URLSearchParams()
      params.set('process_message', String(message.id))

      if (mode === 'code') {
        router.push(`/code?${params.toString()}`)
        return
      }

      if (mode === 'device') {
        const preferredDevice = getPreferredExecutionDevice(devices)
        if (preferredDevice?.device_id) {
          params.set('deviceId', preferredDevice.device_id)
        } else {
          toast.error(t('messages.device_fallback_to_chat'))
        }
      }

      router.push(`/chat?${params.toString()}`)
    },
    [devices, router, t]
  )

  // Handle batch process messages
  const handleBatchProcessMessages = useCallback(
    (messageIds: number[]) => {
      if (messageIds.length === 0) return
      // Navigate to chat page with comma-separated message IDs
      router.push(`/chat?process_message=${messageIds.join(',')}`)
    },
    [router]
  )

  return (
    <div className="flex h-full">
      {/* Queue sidebar */}
      <div className="w-64 flex-shrink-0 border-r border-border">
        <QueueSidebar
          onCreateQueue={handleCreateQueue}
          onEditQueue={handleEditQueue}
          onDeleteQueue={handleDeleteQueue}
          onSetDefault={handleSetDefault}
        />
      </div>

      {/* Message list */}
      <div className="flex-1 min-w-0">
        <MessageList
          onViewMessage={handleViewMessage}
          onProcessMessage={handleProcessMessage}
          onBatchProcessMessages={handleBatchProcessMessages}
        />
      </div>

      {/* Queue edit dialog */}
      <QueueEditDialog
        queue={editingQueue}
        open={editQueueDialogOpen}
        onOpenChange={setEditQueueDialogOpen}
      />

      {/* Queue delete confirmation */}
      <AlertDialog open={deleteQueueDialogOpen} onOpenChange={setDeleteQueueDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('queues.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('queues.delete_confirm_message')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteQueue}
              disabled={deleteLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteLoading ? t('common:actions.loading') : t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Message detail dialog */}
      <MessageDetailDialog
        message={selectedMessage}
        open={messageDetailDialogOpen}
        onOpenChange={setMessageDetailDialogOpen}
        onProcess={handleProcessMessage}
      />
    </div>
  )
}
