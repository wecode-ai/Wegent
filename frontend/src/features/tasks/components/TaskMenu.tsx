// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Menu } from '@headlessui/react'
import {
  ClipboardDocumentIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { HiOutlineEllipsisVertical } from 'react-icons/hi2'

interface TaskMenuProps {
  taskId: number
  handleCopyTaskId: (taskId: number) => void
  handleDeleteTask: (taskId: number) => void
}

export default function TaskMenu({
  taskId,
  handleCopyTaskId,
  handleDeleteTask
}: TaskMenuProps) {
  return (
    <Menu as="div" className="relative">
      <Menu.Button
        onClick={(e) => e.stopPropagation()}
        className="text-gray-500 hover:text-white p-1"
      >
        <HiOutlineEllipsisVertical className="h-4 w-4" />
      </Menu.Button>
      <Menu.Items className="absolute right-0 top-full mt-1 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-30 min-w-[120px] py-1">
        <Menu.Item>
          {({ active }) => (
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleCopyTaskId(taskId)
              }}
              className={`w-full px-3 py-2 text-xs text-left text-white flex items-center ${active ? 'bg-[#21262d]' : ''}`}
            >
              <ClipboardDocumentIcon className="h-3.5 w-3.5 mr-2" />
              Copy TaskId
            </button>
          )}
        </Menu.Item>
        <Menu.Item>
          {({ active }) => (
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleDeleteTask(taskId)
              }}
              className={`w-full px-3 py-2 text-xs text-left text-white flex items-center ${active ? 'bg-[#21262d]' : ''}`}
            >
              <TrashIcon className="h-3.5 w-3.5 mr-2" />
              Delete Task
            </button>
          )}
        </Menu.Item>
      </Menu.Items>
    </Menu>
  )
}