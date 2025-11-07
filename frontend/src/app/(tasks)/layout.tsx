// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { UserProvider } from '@/features/common/UserContext'
import { TaskContextProvider } from '@/features/tasks/contexts/taskContext'

/**
 * Shared layout for chat and code pages to reuse TaskContextProvider
 * This prevents task list from being reloaded when switching between pages
 */
export default function TasksLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <UserProvider>
      <TaskContextProvider>
        {children}
      </TaskContextProvider>
    </UserProvider>
  )
}
