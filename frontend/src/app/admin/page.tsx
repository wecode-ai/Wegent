// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useState, useCallback, useEffect, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import UserMenu from '@/features/layout/UserMenu'
import { Tab } from '@headlessui/react'
import { Layers } from 'lucide-react'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import QuickTeamsConfig from '@/features/admin/components/QuickTeamsConfig'

function AdminContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoading } = useUser()

  // Tab index to name mapping
  const tabIndexToName = useMemo(
    (): Record<number, string> => ({
      0: 'quick-teams',
    }),
    []
  )

  // Tab name to index mapping
  const tabNameToIndex = useMemo(
    (): Record<string, number> => ({
      'quick-teams': 0,
    }),
    []
  )

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

  const handleTabChange = useCallback(
    (idx: number) => {
      setTabIndex(idx)
      const tabName = tabIndexToName[idx] || 'quick-teams'
      router.replace(`?tab=${tabName}`)
    },
    [router, tabIndexToName]
  )

  // Check if user is admin
  const isAdmin = useMemo(() => {
    if (!user) return false
    return user.role === 'admin' || user.user_name === 'admin'
  }, [user])

  // Redirect non-admin users
  useEffect(() => {
    if (!loading && !isAdmin) {
      router.push('/chat')
    }
  }, [loading, isAdmin, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-base">
        <div className="text-text-muted">Loading...</div>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-base">
        <div className="text-text-muted">Access denied. Admin permission required.</div>
      </div>
    )
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Navigation */}
        <TopNavigation activePage="admin" variant="standalone" showLogo={true}>
          <GithubStarButton />
          <UserMenu />
        </TopNavigation>

        {/* Admin Content with Tabs */}
        <div className="flex-1 overflow-x-hidden">
          <div className="w-full min-w-0">
            <Tab.Group
              selectedIndex={tabIndex}
              onChange={handleTabChange}
              className={isDesktop ? 'flex' : 'block'}
            >
              {/* Conditional rendering based on screen size */}
              {isDesktop ? (
                /* Desktop Layout */
                <>
                  <Tab.List className="w-64 bg-base flex flex-col space-y-1 px-8 py-4 focus:outline-none">
                    <div className="flex items-center gap-2 px-3 py-2 mb-4">
                      <span className="text-lg font-semibold text-text-primary">Admin</span>
                    </div>
                    <Tab
                      className={({ selected }) =>
                        `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                          selected
                            ? 'bg-muted text-text-primary'
                            : 'text-text-muted hover:text-text-primary hover:bg-muted'
                        }`
                      }
                    >
                      <Layers className="w-4 h-4" />
                      <span>Quick Teams</span>
                    </Tab>
                  </Tab.List>

                  <div className="flex-1 min-h-0 px-8 py-4 overflow-y-auto min-w-0">
                    <Tab.Panels>
                      <Tab.Panel className="focus:outline-none">
                        <QuickTeamsConfig />
                      </Tab.Panel>
                    </Tab.Panels>
                  </div>
                </>
              ) : (
                /* Mobile Layout */
                <>
                  <div className="bg-base border-b border-border">
                    <div className="px-4 py-2 text-lg font-semibold">Admin</div>
                    <Tab.List className="flex space-x-1 px-2 py-2">
                      <Tab
                        className={({ selected }) =>
                          `flex-1 flex items-center justify-center space-x-1 px-2 py-2 text-xs rounded-md transition-colors duration-200 focus:outline-none ${
                            selected
                              ? 'bg-muted text-text-primary'
                              : 'text-text-muted hover:text-text-primary hover:bg-muted'
                          }`
                        }
                      >
                        <Layers className="w-3 h-3" />
                        <span>Quick Teams</span>
                      </Tab>
                    </Tab.List>
                  </div>

                  <div className="flex-1 min-h-0 px-2 py-2 overflow-y-auto min-w-0">
                    <Tab.Panels>
                      <Tab.Panel className="focus:outline-none">
                        <QuickTeamsConfig />
                      </Tab.Panel>
                    </Tab.Panels>
                  </div>
                </>
              )}
            </Tab.Group>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function AdminPage() {
  return (
    <UserProvider>
      <Suspense fallback={<div>Loading...</div>}>
        <AdminContent />
      </Suspense>
    </UserProvider>
  )
}
