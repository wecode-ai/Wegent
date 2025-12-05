// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopNavigation from '@/features/layout/TopNavigation';
import UserMenu from '@/features/layout/UserMenu';
import { Tab } from '@headlessui/react';
import {
  PuzzlePieceIcon,
  UsersIcon,
  BellIcon,
  CpuChipIcon,
  CommandLineIcon,
} from '@heroicons/react/24/outline';
import GitHubIntegration from '@/features/settings/components/GitHubIntegration';
import TeamList from '@/features/settings/components/TeamList';
import NotificationSettings from '@/features/settings/components/NotificationSettings';
import ModelList from '@/features/settings/components/ModelList';
import ShellList from '@/features/settings/components/ShellList';
import { UserProvider } from '@/features/common/UserContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GithubStarButton } from '@/features/layout/GithubStarButton';

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation('common');

  // Tab index to name mapping
  const tabIndexToName = useMemo(
    (): Record<number, string> => ({
      0: 'models',
      1: 'shells',
      2: 'team',
      3: 'integrations',
      4: 'notifications',
    }),
    []
  );

  // Tab name to index mapping
  const tabNameToIndex = useMemo(
    (): Record<string, number> => ({
      models: 0,
      shells: 1,
      team: 2,
      integrations: 3,
      notifications: 4,
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
      const tabName = tabIndexToName[idx] || 'models';
      router.replace(`?tab=${tabName}`);
    },
    [router, tabIndexToName]
  );

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Navigation */}
        <TopNavigation activePage="dashboard" variant="standalone" showLogo={true}>
          <GithubStarButton />
          <UserMenu />
        </TopNavigation>

        {/* Dashboard Content with Tabs */}
        <div className="flex-1 overflow-x-hidden flex flex-col min-h-0">
          <div className="w-full min-w-0 flex-1 flex flex-col min-h-0">
            <Tab.Group
              selectedIndex={tabIndex}
              onChange={handleTabChange}
              className={isDesktop ? 'flex h-full' : 'flex flex-col h-full'}
            >
              {/* Conditional rendering based on screen size */}
              {isDesktop ? (
                /* Desktop Layout */
                <>
                  <Tab.List className="w-64 bg-base flex flex-col space-y-1 px-8 py-4 focus:outline-none">
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
                      <span>{t('settings.models')}</span>
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
                      <CommandLineIcon className="w-4 h-4" />
                      <span>{t('settings.shells')}</span>
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
                      <UsersIcon className="w-4 h-4" />
                      <span>{t('settings.team')}</span>
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
                      <PuzzlePieceIcon className="w-4 h-4" />
                      <span>{t('settings.integrations')}</span>
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
                      <BellIcon className="w-4 h-4" />
                      <span>{t('settings.sections.general')}</span>
                    </Tab>
                  </Tab.List>

                  <div className="flex-1 min-h-0 px-8 py-4 min-w-0 flex flex-col overflow-hidden">
                    <Tab.Panels className="flex-1 flex flex-col min-h-0 overflow-hidden">
                      <Tab.Panel className="focus:outline-none flex-1 flex flex-col min-h-0 overflow-y-auto">
                        <ModelList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none flex-1 flex flex-col min-h-0 overflow-y-auto">
                        <ShellList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none flex-1 flex flex-col min-h-0 overflow-hidden">
                        <TeamList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none overflow-y-auto">
                        <GitHubIntegration />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none overflow-y-auto">
                        <NotificationSettings />
                      </Tab.Panel>
                    </Tab.Panels>
                  </div>
                </>
              ) : (
                /* Mobile Layout */
                <>
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
                        <CpuChipIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.models')}</span>
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
                        <CommandLineIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.shells')}</span>
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
                        <UsersIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.team')}</span>
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
                        <PuzzlePieceIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.integrations')}</span>
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
                        <BellIcon className="w-3 h-3" />
                        <span className="hidden xs:inline">{t('settings.sections.general')}</span>
                      </Tab>
                    </Tab.List>
                  </div>

                  <div className="flex-1 min-h-0 px-2 py-2 overflow-y-auto min-w-0">
                    <Tab.Panels>
                      <Tab.Panel className="focus:outline-none">
                        <ModelList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <ShellList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <TeamList />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <GitHubIntegration />
                      </Tab.Panel>
                      <Tab.Panel className="focus:outline-none">
                        <NotificationSettings />
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
  );
}

export default function DashboardPage() {
  return (
    <UserProvider>
      <Suspense fallback={<div>Loading...</div>}>
        <DashboardContent />
      </Suspense>
    </UserProvider>
  );
}
