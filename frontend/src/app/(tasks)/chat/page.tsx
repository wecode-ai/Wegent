// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams, useRouter } from 'next/navigation'
import { useTeamContext } from '@/contexts/TeamContext'
import OnboardingTour from '@/features/onboarding/OnboardingTour'
import { TaskParamSync, DeviceTaskSync, DeviceParamSync } from '@/features/tasks/components/params'
import { TeamShareHandler, TaskShareHandler } from '@/features/tasks/components/share'
import { InviteJoinHandler } from '@/features/tasks/components/group-chat'
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'

// Dynamic imports for mobile and desktop page components with code splitting
const ChatPageDesktop = dynamic(
  () => import('./ChatPageDesktop').then(mod => ({ default: mod.ChatPageDesktop })),
  {
    ssr: false,
  }
)

const ChatPageMobile = dynamic(
  () => import('./ChatPageMobile').then(mod => ({ default: mod.ChatPageMobile })),
  {
    ssr: false,
  }
)

/**
 * Chat Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with drawer sidebar
 * - Desktop: ≥768px - Full-featured UI with resizable sidebar
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function ChatPage() {
  // Team state from context (centralized to avoid duplicate API calls)
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  // Task context
  const { refreshTasks, selectedTaskDetail } = useTaskContext()

  // User state for git token check
  const { user } = useUser()

  // Router for navigation
  const router = useRouter()

  // Check for share_id in URL
  const searchParams = useSearchParams()
  const hasShareId = !!searchParams.get('share_id')

  // Check if a task is currently open
  const taskId =
    searchParams.get('task_id') || searchParams.get('taskid') || searchParams.get('taskId')

  // Redirect device tasks to /devices/chat page for proper layout
  useEffect(() => {
    if (selectedTaskDetail?.task_type === 'task' && taskId) {
      const params = new URLSearchParams()
      params.set('taskId', String(taskId))
      if (selectedTaskDetail.device_id) {
        params.set('deviceId', selectedTaskDetail.device_id)
      }
      router.replace(`/devices/chat?${params.toString()}`)
    }
  }, [selectedTaskDetail?.task_type, selectedTaskDetail?.device_id, taskId, router])

  // Check for pending task share from public page (after login)
  useEffect(() => {
    const pendingToken = localStorage.getItem('pendingTaskShare')
    if (pendingToken) {
      // Clear the pending token
      localStorage.removeItem('pendingTaskShare')
      // Redirect to chat page with taskShare parameter to trigger the copy modal
      router.push(`/chat?taskShare=${pendingToken}`)
    }
  }, [router])

  // Mobile detection
  const isMobile = useIsMobile()

  // Check if user has git token
  const hasGitToken = !!(user?.git_info && user.git_info.length > 0)

  const handleRefreshTeams = async () => {
    return await refreshTeams()
  }

  return (
    <>
      {/* Handle OIDC token from URL parameters */}
      <OidcTokenHandler />
      <Suspense>
        <TaskParamSync />
        <DeviceTaskSync />
        <DeviceParamSync />
      </Suspense>
      <Suspense>
        <TeamShareHandler teams={teams} onRefreshTeams={handleRefreshTeams} />
      </Suspense>
      <Suspense>
        <TaskShareHandler onTaskCopied={refreshTasks} />
      </Suspense>
      {/* Handle group chat invite links */}
      <Suspense>
        <InviteJoinHandler />
      </Suspense>
      {/* Onboarding tour */}
      <OnboardingTour
        hasTeams={teams.length > 0}
        hasGitToken={hasGitToken}
        currentPage="chat"
        isLoading={isTeamsLoading}
        hasShareId={hasShareId}
      />
      {/* Route to mobile or desktop component based on screen size */}
      {isMobile ? <ChatPageMobile /> : <ChatPageDesktop />}
    </>
  )
}
