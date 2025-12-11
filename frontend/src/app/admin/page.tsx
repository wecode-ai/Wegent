// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopNavigation from '@/features/layout/TopNavigation';
import UserMenu from '@/features/layout/UserMenu';
import { Tab } from '@headlessui/react';
import { UsersIcon, CpuChipIcon, ShieldExclamationIcon } from '@heroicons/react/24/outline';
import UserList from '@/features/admin/components/UserList';
import PublicModelList from '@/features/admin/components/PublicModelList';
import { UserProvider, useUser } from '@/features/common/UserContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { Button } from '@/components/ui/button';

function AccessDenied() {
  const { t } = useTranslation('admin');

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <ShieldExclamationIcon className="w-16 h-16 text-text-muted mb-4" />
      <h1 className="text-2xl font-semibold text-text-primary mb-2">{t('access_denied.title')}</h1>
      <p className="text-text-muted mb-6 max-w-md">{t('access_denied.message')}</p>
      <Link href="/">
        <Button>{t('access_denied.go_home')}</Button>
      </Link>
    </div>
  );
}

function AdminContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation('admin');
  const { user, isLoading } = useUser();

  // Check if user is admin
  const isAdmin = user?.role === 'admin';

  // Tab index to name mapping
  const tabIndexToName = useMemo(
    (): Record<number, string> => ({
      0: 'users',
      1: 'public-models',
    }),
    []
  );

  // Tab name to index mapping
  const tabNameToIndex = useMemo(
    (): Record<string, number> => ({
      users: 0,
      'public-models': 1,
    }),
    []
  );

  // Function to get initial tab index from URL
  const getInitialTabIndex = () => {
    const tabParam = searchParams.get('tab');
    if (tabParam && tabNameToIndex.hasOwnProperty(tabParam)) {
      return tabNameToIndex[tabParam];
    }
    return 0; // default to first tab
  };

  // Initialize tabIndex based on URL parameter
  const [tabIndex, setTabIndex] = useState(getInitialTabIndex);

  // Detect screen size for responsive behavior
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsDesktop(window.innerWidth >= 1024); // 1024px as desktop breakpoint
    };

    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  const handleTabChange = useCallback(
    (idx: number) => {
      setTabIndex(idx);
      const tabName = tabIndexToName[idx] || 'users';
      router.replace(`?tab=${tabName}`);
    },
    [router, tabIndexToName]
  );

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  // Show access denied if not admin
  if (!isAdmin) {
    return (
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        <div className="flex-1 flex flex-col">
          <TopNavigation activePage="dashboard" variant="standalone" showLogo={true}>
            <GithubStarButton />
            <UserMenu />
          </TopNavigation>
          <AccessDenied />
        </div>
      </div>
    );
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Navigation */}
        <TopNavigation activePage="dashboard" variant="standalone" showLogo={true}>
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
                    <div className="mb-4">
                      <h1 className="text-lg font-semibold text-text-primary">{t('title')}</h1>
                      <p className="text-xs text-text-muted">{t('description')}</p>
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
                      <UsersIcon className="w-4 h-4" />
                      <span>{t('tabs.users')}</span>
                    </Tab>

                    <Tab
                      className={({ selected }) =>
                        `w-full flex items-center space-x-3 px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                          selected
                            ? 'bg-muted text-text-primary'
                            : 'text-text-muted hover:text-text-primary hover:bg-muted'
                        }`
                      }
                    >
                      <CpuChipIcon className="w-4 h-4" />
                      <span>{t('tabs.public_models')}</span>
                    </Tab>
                  </Tab.List>

                  <div className="flex-1 min-h-0 px-8 py-4 overflow-y-auto min-w-0">
                    <Tab.Panels>
                      <Tab.Panel className="focus:outline-none">
                        <UserList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <PublicModelList />
                      </Tab.Panel>
                    </Tab.Panels>
                  </div>
                </>
              ) : (
                /* Mobile Layout */
                <>
                  <div className="bg-base border-b border-border px-4 py-2">
                    <h1 className="text-lg font-semibold text-text-primary">{t('title')}</h1>
                  </div>
                  <div className="bg-base border-b border-border">
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
                        <UsersIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('tabs.users')}</span>
                      </Tab>

                      <Tab
                        className={({ selected }) =>
                          `flex-1 flex items-center justify-center space-x-1 px-2 py-2 text-xs rounded-md transition-colors duration-200 focus:outline-none ${
                            selected
                              ? 'bg-muted text-text-primary'
                              : 'text-text-muted hover:text-text-primary hover:bg-muted'
                          }`
                        }
                      >
                        <CpuChipIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('tabs.public_models')}</span>
                      </Tab>
                    </Tab.List>
                  </div>

                  <div className="flex-1 min-h-0 px-2 py-2 overflow-y-auto min-w-0">
                    <Tab.Panels>
                      <Tab.Panel className="focus:outline-none">
                        <UserList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <PublicModelList />
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
  );
}

export default function AdminPage() {
  return (
    <UserProvider>
      <Suspense fallback={<div>Loading...</div>}>
        <AdminContent />
      </Suspense>
    </UserProvider>
  );
}
