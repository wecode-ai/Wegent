// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Menu } from '@headlessui/react'
import {
  ClipboardDocumentIcon,
  TrashIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { HiOutlineEllipsisVertical } from 'react-icons/hi2'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskStatus } from '@/types/api'

interface TaskMenuProps {
  taskId: number
  taskStatus?: TaskStatus
  handleCopyTaskId: (taskId: number) => void
  handleDeleteTask: (taskId: number) => void
  handleCancelTask?: (taskId: number) => void
}

export default function TaskMenu({
  taskId,
  taskStatus,
  handleCopyTaskId,
  handleDeleteTask,
  handleCancelTask
}: TaskMenuProps) {
  const { t } = useTranslation('common')

  // Show cancel option only for running tasks
  const canCancel = taskStatus === 'pending' || taskStatus === 'running'

  return (
    <Menu as="div" className="relative">
      <Menu.Button
        onClick={(e) => e.stopPropagation()}
        className="text-text-muted hover:text-text-primary p-1"
      >
        <HiOutlineEllipsisVertical className="h-4 w-4" />
      </Menu.Button>
      <Menu.Items
        className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg z-30 min-w-[120px] py-1"
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        <Menu.Item>
          {({ active }) => (
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleCopyTaskId(taskId)
              }}
              className={`w-full px-3 py-2 text-xs text-left text-text-primary flex items-center ${active ? 'bg-muted' : ''}`}
            >
              <ClipboardDocumentIcon className="h-3.5 w-3.5 mr-2" />
              {t('tasks.copy_task_id')}
            </button>
          )}
        </Menu.Item>
        {canCancel && handleCancelTask && (
          <Menu.Item>
            {({ active }) => (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleCancelTask(taskId)
                }}
                className={`w-full px-3 py-2 text-xs text-left text-text-primary flex items-center ${active ? 'bg-muted' : ''}`}
              >
                <XCircleIcon className="h-3.5 w-3.5 mr-2" />
                {t('tasks.cancel_task')}
              </button>
            )}
          </Menu.Item>
        )}
        <Menu.Item>
          {({ active }) => (
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleDeleteTask(taskId)
              }}
              className={`w-full px-3 py-2 text-xs text-left text-text-primary flex items-center ${active ? 'bg-muted' : ''}`}
            >
              <TrashIcon className="h-3.5 w-3.5 mr-2" />
              {t('tasks.delete_task')}
            </button>
          )}
        </Menu.Item>
      </Menu.Items>
    </Menu>
  )
}
