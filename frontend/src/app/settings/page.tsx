// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useState, useCallback, useEffect, useLayoutEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import UserMenu from '@/features/layout/UserMenu'
import { Tab } from '@headlessui/react'
import { PuzzlePieceIcon, UsersIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import GitHubIntegration from '@/features/settings/components/GitHubIntegration'
import BotList from '@/features/settings/components/BotList'
import TeamList from '@/features/settings/components/TeamList'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'
import { GithubStarButton } from '@/features/layout/GithubStarButton'

function DashboardContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useTranslation('common')

  // Tab index to name mapping
  const tabIndexToName: Record<number, string> = {
    0: 'integrations',
    1: 'bots',
    2: 'team'
  }

  // Tab name to index mapping
  const tabNameToIndex: Record<string, number> = {
    integrations: 0,
    bots: 1,
    team: 2
  }

  // Function to get initial tab index from URL
  const getInitialTabIndex = () => {
    const tabParam = searchParams.get('tab')
    if (tabParam && tabNameToIndex.hasOwnProperty(tabParam)) {
      return tabNameToIndex[tabParam]
    }
    return 0 // default to first tab
  }

  // Initialize tabIndex based on URL parameter
  const [tabIndex, setTabIndex] = useState(getInitialTabIndex)

  // Detect screen size for responsive behavior
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    const checkScreenSize = () => {
      setIsDesktop(window.innerWidth >= 1024) // 1024px as desktop breakpoint
    }

    checkScreenSize()
    window.addEventListener('resize', checkScreenSize)
    return () => window.removeEventListener('resize', checkScreenSize)
  }, [])

  const handleTabChange = useCallback((idx: number) => {
    setTabIndex(idx)
    const tabName = tabIndexToName[idx] || 'integrations'
    router.replace(`?tab=${tabName}`)
  }, [router, tabIndexToName])

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Navigation */}
        <TopNavigation
          activePage="dashboard"
          variant="standalone"
          showLogo={false}
        >
          <GithubStarButton />
          <UserMenu />
        </TopNavigation>


        {/* Dashboard Content with Tabs */}
        <div className="flex-1 overflow-x-hidden">
          <div className="w-full min-w-0">
            <Tab.Group
              selectedIndex={tabIndex}
              onChange={handleTabChange}
              className={isDesktop ? "flex" : "block"}
            >
              {/* Conditional rendering based on screen size */}
              {isDesktop ? (
                /* Desktop Layout */
                <>
                  <Tab.List className="w-64 bg-base flex flex-col space-y-1 px-8 py-4 focus:outline-none">
                    <Tab className={({ selected }) =>
                      `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                        selected
                          ? 'bg-muted text-text-primary'
                          : 'text-text-muted hover:text-text-primary hover:bg-muted'
                      }`
                    }>
                      <PuzzlePieceIcon className="w-4 h-4" /><span>{t('settings.integrations')}</span>
                    </Tab>

                    <Tab className={({ selected }) =>
                      `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                        selected
                          ? 'bg-muted text-text-primary'
                          : 'text-text-muted hover:text-text-primary hover:bg-muted'
                      }`
                    }>
                      <RiRobot2Line className="w-4 h-4" />
                      <span>{t('settings.bot')}</span>
                    </Tab>

                    <Tab className={({ selected }) =>
                      `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                        selected
                          ? 'bg-muted text-text-primary'
                          : 'text-text-muted hover:text-text-primary hover:bg-muted'
                      }`
                    }>
                      <UsersIcon className="w-4 h-4" />
                      <span>{t('settings.team')}</span>
                    </Tab>
                  </Tab.List>

                  <div className="flex-1 min-h-0 px-8 py-4 overflow-y-auto min-w-0">
                    <Tab.Panels>
                      <Tab.Panel className="focus:outline-none">
                        <GitHubIntegration />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <BotList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <TeamList />
                      </Tab.Panel>
                    </Tab.Panels>
                  </div>
                </>
              ) : (
                /* Mobile Layout */
                <>
                  <div className="bg-base border-b border-border">
                    <Tab.List className="flex space-x-1 px-2 py-2">
                      <Tab className={({ selected }) =>
                        `flex-1 flex items-center justify-center space-x-1 px-2 py-2 text-xs rounded-md transition-colors duration-200 focus:outline-none ${
                          selected
                            ? 'bg-muted text-text-primary'
                            : 'text-text-muted hover:text-text-primary hover:bg-muted'
                        }`
                      }>
                        <PuzzlePieceIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.integrations')}</span>
                      </Tab>

                      <Tab className={({ selected }) =>
                        `flex-1 flex items-center justify-center space-x-1 px-2 py-2 text-xs rounded-md transition-colors duration-200 focus:outline-none ${
                          selected
                            ? 'bg-muted text-text-primary'
                            : 'text-text-muted hover:text-text-primary hover:bg-muted'
                        }`
                      }>
                        <RiRobot2Line className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.bot')}</span>
                      </Tab>

                      <Tab className={({ selected }) =>
                        `flex-1 flex items-center justify-center space-x-1 px-2 py-2 text-xs rounded-md transition-colors duration-200 focus:outline-none ${
                          selected
                            ? 'bg-muted text-text-primary'
                            : 'text-text-muted hover:text-text-primary hover:bg-muted'
                        }`
                      }>
                        <UsersIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.team')}</span>
                      </Tab>
                    </Tab.List>
                  </div>

                  <div className="flex-1 min-h-0 px-2 py-2 overflow-y-auto min-w-0">
                    <Tab.Panels>
                      <Tab.Panel className="focus:outline-none">
                        <GitHubIntegration />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <BotList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <TeamList />
                      </Tab.Panel>
                    </Tab.Panels>
                  </div>
                </>
              )}
            </Tab.Group>
          </div>
        </div>
      </div>
      {/* No Bot Creation Modal needed here as it's now part of the BotList component */}
    </div>
  )
}

export default function DashboardPage() {
  return (
    <UserProvider>
      <Suspense fallback={<div>Loading...</div>}>
        <DashboardContent />
      </Suspense>
    </UserProvider>
  )
}
