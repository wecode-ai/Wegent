// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { teamService } from '@/features/tasks/service/teamService'
import OnboardingTour from '@/features/onboarding/OnboardingTour'
import { TaskParamSync } from '@/features/tasks/components/params'
import { TeamShareHandler } from '@/features/tasks/components/share'
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useUser } from '@/features/common/UserContext'

// Dynamic imports for mobile and desktop page components with code splitting
const CodePageDesktop = dynamic(
  () => import('./CodePageDesktop').then(mod => ({ default: mod.CodePageDesktop })),
  {
    ssr: false,
  }
)

const CodePageMobile = dynamic(
  () => import('./CodePageMobile').then(mod => ({ default: mod.CodePageMobile })),
  {
    ssr: false,
  }
)

/**
 * Code Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with drawer sidebar (no workbench)
 * - Desktop: ≥768px - Full-featured UI with resizable sidebar and workbench panel
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function CodePage() {
  // Get search params to check for taskId
  const searchParams = useSearchParams()
  const hasShareId = !!searchParams.get('share_id')

  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()

  // User state for git token check
  const { user } = useUser()

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
      </Suspense>
      <Suspense>
        <TeamShareHandler
          teams={teams}
          onTeamSelected={() => {}}
          onRefreshTeams={handleRefreshTeams}
        />
      </Suspense>
      {/* Onboarding tour */}
      <OnboardingTour
        hasTeams={teams.length > 0}
        hasGitToken={hasGitToken}
        currentPage="code"
        isLoading={isTeamsLoading}
        hasShareId={hasShareId}
      />
      {/* Route to mobile or desktop component based on screen size */}
      {isMobile ? <CodePageMobile /> : <CodePageDesktop />}
    </>
  )
}
