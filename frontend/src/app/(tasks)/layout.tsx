// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import { UserProvider } from '@/features/common/UserContext'
import { TaskSessionProvider } from '@/features/tasks/session/TaskSession'
import { SocketProvider } from '@/contexts/SocketContext'
import { DeviceProvider } from '@/contexts/DeviceContext'
import { TeamProvider } from '@/contexts/TeamContext'
import { ProjectProvider } from '@/features/projects/contexts/projectContext'
import { PetProvider } from '@/features/pet/contexts/PetContext'
import { SetupWizardProvider } from '@/features/admin/contexts/SetupWizardContext'

const PetWidget = dynamic(
  () => import('@/features/pet/components/PetWidget').then(mod => ({ default: mod.PetWidget })),
  { ssr: false }
)

const PetStreamingBridge = dynamic(
  () =>
    import('@/features/pet/components/PetStreamingBridge').then(mod => ({
      default: mod.PetStreamingBridge,
    })),
  { ssr: false }
)

const GlobalAdminSetupWizard = dynamic(
  () => import('@/features/admin/components/GlobalAdminSetupWizard'),
  { ssr: false }
)

/**
 * Shared layout for chat and coding mode to reuse TaskSessionProvider.
 * This prevents task list from being reloaded when switching modes
 * and allows chat streams to continue running in the background
 *
 * SocketProvider is added for real-time WebSocket communication
 * DeviceProvider is added for local device management
 * TeamProvider is added to centralize team data fetching and avoid duplicate API calls
 * PetProvider and PetWidget are added for the pet nurturing feature
 * PetStreamingBridge syncs AI streaming state with pet animation
 * SetupWizardProvider shares setup wizard state with other components (e.g., OnboardingTour)
 * GlobalAdminSetupWizard shows setup wizard for admin users on first login
 */
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return (
    <UserProvider>
      <SocketProvider>
        <DeviceProvider>
          <TeamProvider>
            <ProjectProvider>
              <PetProvider>
                <SetupWizardProvider>
                  <TaskSessionProvider>
                    {children}
                    <PetStreamingBridge />
                    <PetWidget />
                    <GlobalAdminSetupWizard />
                  </TaskSessionProvider>
                </SetupWizardProvider>
              </PetProvider>
            </ProjectProvider>
          </TeamProvider>
        </DeviceProvider>
      </SocketProvider>
    </UserProvider>
  )
}
