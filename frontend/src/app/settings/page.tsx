// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useState } from 'react'
import { useRouter } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import UserMenu from '@/features/layout/UserMenu'
import { Tab } from '@headlessui/react'
import { PuzzlePieceIcon, UsersIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import GitHubIntegration from '@/features/settings/components/GitHubIntegration'
import BotList from '@/features/settings/components/BotList'
import TabParamSync from '@/features/settings/components/TabParamSync'
import TeamList from '@/features/settings/components/TeamList'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'

function DashboardContent() {
  const [tabIndex, setTabIndex] = useState(0)
  const router = useRouter()
  const { t } = useTranslation('common')

  // Tab index to name mapping
  const tabIndexToName: Record<number, string> = {
    0: 'integrations',
    1: 'bots',
    2: 'team'
  }

  const handleTabChange = (idx: number) => {
    setTabIndex(idx)
    // Sync URL parameters
    const tabName = tabIndexToName[idx] || 'integrations'
    router.replace(`?tab=${tabName}`)
  }

  return (
    <div className="flex h-screen bg-[#0d1117] text-white">
      {/* Wrap TabParamSync component with Suspense */}
      <Suspense fallback={null}>
        <TabParamSync tabIndex={tabIndex} setTabIndex={setTabIndex} />
      </Suspense>
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Navigation */}
        <TopNavigation
          activePage="dashboard"
          showLogo={true}
        >
          {/* User Avatar Menu */}
          <UserMenu position="right-6" />
        </TopNavigation>

        {/* Dashboard Content with Tabs */}
        <div className="flex-1 flex justify-center">
          <div className="w-full max-w-7xl">
            <Tab.Group selectedIndex={tabIndex} onChange={handleTabChange}>
              <div className="flex">
                {/* Left Sidebar Menu - Tab List */}
                <div className="w-64 bg-[#0d1117] px-8 py-4">
                  <Tab.List className="space-y-1 focus:outline-none">
                    <Tab className={({ selected }) =>
                      `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                        selected
                          ? 'bg-[#21262d] text-white'
                          : 'text-gray-400 hover:text-white hover:bg-[#21262d]'
                      }`
                    }>
                      <PuzzlePieceIcon className="w-4 h-4" /><span>{t('settings.integrations')}</span>
                    </Tab>
                    
                    <Tab className={({ selected }) =>
                      `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                        selected
                          ? 'bg-[#21262d] text-white'
                          : 'text-gray-400 hover:text-white hover:bg-[#21262d]'
                      }`
                    }>
                      <RiRobot2Line className="w-4 h-4" />
                      <span>{t('settings.bot')}</span>
                    </Tab>

                    <Tab className={({ selected }) =>
                      `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                        selected
                          ? 'bg-[#21262d] text-white'
                          : 'text-gray-400 hover:text-white hover:bg-[#21262d]'
                      }`
                    }>
                      <UsersIcon className="w-4 h-4" />
                      <span>{t('settings.team')}</span>
                    </Tab>
                  </Tab.List>
                </div>

                {/* Content Area - Tab Panels */}
                <div className="flex-1 px-8 py-4">
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
              </div>
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
      <DashboardContent />
    </UserProvider>
  )
}