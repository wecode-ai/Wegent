// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { UserProvider } from '@/features/common/UserContext';
import { TaskContextProvider } from '@/features/tasks/contexts/taskContext';
import { ChatStreamProvider } from '@/features/tasks/contexts/chatStreamContext';

/**
 * Shared layout for chat and code pages to reuse TaskContextProvider and ChatStreamProvider
 * This prevents task list from being reloaded when switching between pages
 * and allows chat streams to continue running in the background
 */
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return (
    <UserProvider>
      <TaskContextProvider>
        <ChatStreamProvider>{children}</ChatStreamProvider>
      </TaskContextProvider>
    </UserProvider>
  );
}
