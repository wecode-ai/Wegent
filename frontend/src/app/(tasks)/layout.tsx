// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { UserProvider } from '@/features/common/UserContext'
import { TaskContextProvider } from '@/features/tasks/contexts/taskContext'
import { ChatStreamProvider } from '@/features/tasks/contexts/chatStreamContext'
import { SocketProvider } from '@/contexts/SocketContext'
import { DeviceProvider } from '@/contexts/DeviceContext'
import { PetProvider, PetWidget, PetStreamingBridge } from '@/features/pet'
import GlobalAdminSetupWizard from '@/features/admin/components/GlobalAdminSetupWizard'

/**
 * Shared layout for chat and code pages to reuse TaskContextProvider and ChatStreamProvider
 * This prevents task list from being reloaded when switching between pages
 * and allows chat streams to continue running in the background
 *
 * SocketProvider is added for real-time WebSocket communication
 * DeviceProvider is added for local device management
 * PetProvider and PetWidget are added for the pet nurturing feature
 * PetStreamingBridge syncs AI streaming state with pet animation
 * GlobalAdminSetupWizard shows setup wizard for admin users on first login
 */
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return (
    <UserProvider>
      <SocketProvider>
        <DeviceProvider>
          <PetProvider>
            <TaskContextProvider>
              <ChatStreamProvider>
                {children}
                <PetStreamingBridge />
                <PetWidget />
                <GlobalAdminSetupWizard />
              </ChatStreamProvider>
            </TaskContextProvider>
          </PetProvider>
        </DeviceProvider>
      </SocketProvider>
    </UserProvider>
  )
}
