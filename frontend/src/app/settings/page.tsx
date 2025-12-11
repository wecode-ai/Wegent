// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopNavigation from '@/features/layout/TopNavigation';
import UserMenu from '@/features/layout/UserMenu';
import {
  PuzzlePieceIcon,
  BellIcon,
  UserGroupIcon,
  UserIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import GitHubIntegration from '@/features/settings/components/GitHubIntegration';
import NotificationSettings from '@/features/settings/components/NotificationSettings';
import { GroupManager } from '@/features/settings/components/groups/GroupManager';
import { ModelListWithScope } from '@/features/settings/components/ModelListWithScope';
import { ShellListWithScope } from '@/features/settings/components/ShellListWithScope';
import { TeamListWithScope } from '@/features/settings/components/TeamListWithScope';
import { UserProvider } from '@/features/common/UserContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GithubStarButton } from '@/features/layout/GithubStarButton';

interface MenuItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children?: SubMenuItem[];
}

interface SubMenuItem {
  id: string;
  label: string;
  component: React.ReactNode;
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation('common');

  // Get initial values from URL with backward compatibility
  const getInitialSection = () => {
    const section = searchParams.get('section');
    const tab = searchParams.get('tab');

    // Backward compatibility: map old tab values to new sections
    if (!section && tab) {
      if (tab === 'team') return 'personal';
      if (tab === 'models') return 'personal';
      if (tab === 'shells') return 'personal';
    }

    return section || 'personal';
  };

  const getInitialTab = () => {
    const section = searchParams.get('section');
    const tab = searchParams.get('tab');

    // Backward compatibility: map old tab values to new tab IDs
    if (!section && tab) {
      if (tab === 'team') return 'personal-team';
      if (tab === 'models') return 'personal-models';
      if (tab === 'shells') return 'personal-shells';
    }

    return tab || 'personal-models';
  };

  const [selectedSection, setSelectedSection] = useState(getInitialSection);
  const [selectedTab, setSelectedTab] = useState(getInitialTab);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set([getInitialSection()])
  );

  // Detect screen size for responsive behavior
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsDesktop(window.innerWidth >= 1024);
    };

    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  // Menu structure
  const menuStructure: MenuItem[] = useMemo(
    () => [
      {
        id: 'personal',
        label: t('settings.personal'),
        icon: UserIcon,
        children: [
          {
            id: 'personal-models',
            label: t('settings.models'),
            component: <ModelListWithScope scope="personal" />,
          },
          {
            id: 'personal-shells',
            label: t('settings.shells'),
            component: <ShellListWithScope scope="personal" />,
          },
          {
            id: 'personal-team',
            label: t('settings.team'),
            component: <TeamListWithScope scope="personal" />,
          },
        ],
      },
      {
        id: 'groups',
        label: t('settings.groups'),
        icon: UserGroupIcon,
        children: [
          {
            id: 'group-manager',
            label: t('settings.groupManager'),
            component: <GroupManager />,
          },
          {
            id: 'group-models',
            label: t('settings.models'),
            component: <ModelListWithScope scope="group" />,
          },
          {
            id: 'group-shells',
            label: t('settings.shells'),
            component: <ShellListWithScope scope="group" />,
          },
          {
            id: 'group-team',
            label: t('settings.team'),
            component: <TeamListWithScope scope="group" />,
          },
        ],
      },
      {
        id: 'integrations',
        label: t('settings.integrations'),
        icon: PuzzlePieceIcon,
        children: [
          {
            id: 'integrations',
            label: t('settings.integrations'),
            component: <GitHubIntegration />,
          },
        ],
      },
      {
        id: 'general',
        label: t('settings.sections.general'),
        icon: BellIcon,
        children: [
          {
            id: 'general',
            label: t('settings.sections.general'),
            component: <NotificationSettings />,
          },
        ],
      },
    ],
    [t]
  );

  // Find current component to render
  const currentComponent = useMemo(() => {
    for (const section of menuStructure) {
      if (section.children) {
        const child = section.children.find(c => c.id === selectedTab);
        if (child) return child.component;
      }
    }
    return menuStructure[0]?.children?.[0]?.component || null;
  }, [selectedTab, menuStructure]);

  const handleSectionToggle = (sectionId: string) => {
    setExpandedSections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sectionId)) {
        newSet.delete(sectionId);
      } else {
        newSet.add(sectionId);
      }
      return newSet;
    });
  };

  const handleTabSelect = (sectionId: string, tabId: string) => {
    setSelectedSection(sectionId);
    setSelectedTab(tabId);
    setExpandedSections(prev => new Set(prev).add(sectionId));
    router.replace(`?section=${sectionId}&tab=${tabId}`);
  };

  // Desktop menu item renderer
  // Desktop menu item renderer
  const renderDesktopMenuItem = (item: MenuItem) => {
    const isExpanded = expandedSections.has(item.id);
    const hasChildren = item.children && item.children.length > 0;
    // Check if this is a single-child item (Integrations or General)
    const isSingleChild =
      hasChildren && item.children!.length === 1 && item.children![0].id === item.id;
    return (
      <div key={item.id} className="space-y-1">
        {/* Parent item */}
        <button
          onClick={() => {
            if (isSingleChild && item.children) {
              // For single-child items, directly select the child without expanding
              handleTabSelect(item.id, item.children[0].id);
            } else if (hasChildren) {
              handleSectionToggle(item.id);
              // Auto-select first child when expanding
              if (!isExpanded && item.children) {
                handleTabSelect(item.id, item.children[0].id);
              }
            } else if (item.children?.[0]) {
              handleTabSelect(item.id, item.children[0].id);
            }
          }}
          className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
            selectedSection === item.id
              ? 'bg-muted text-text-primary font-medium'
              : 'text-text-muted hover:text-text-primary hover:bg-muted'
          }`}
        >
          <div className="flex items-center space-x-3">
            <item.icon className="w-4 h-4" />
            <span>{item.label}</span>
          </div>
          {hasChildren && !isSingleChild && (
            <div className="ml-auto">
              {isExpanded ? (
                <ChevronDownIcon className="w-4 h-4" />
              ) : (
                <ChevronRightIcon className="w-4 h-4" />
              )}
            </div>
          )}
        </button>

        {/* Children items - only show for multi-child items */}
        {hasChildren && !isSingleChild && isExpanded && (
          <div className="ml-7 space-y-1">
            {item.children?.map(child => (
              <button
                key={child.id}
                onClick={() => handleTabSelect(item.id, child.id)}
                className={`w-full text-left px-3 py-2 text-sm rounded-md transition-colors duration-200 focus:outline-none ${
                  selectedTab === child.id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-text-secondary hover:text-text-primary hover:bg-muted'
                }`}
              >
                {child.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Mobile menu renderer (simplified, no tree structure)
  const renderMobileMenu = () => {
    const allTabs = menuStructure.flatMap(
      section =>
        section.children?.map(child => ({
          ...child,
          sectionId: section.id,
          sectionLabel: section.label,
        })) || []
    );

    return (
      <div className="bg-base border-b border-border overflow-x-auto">
        <div className="flex space-x-1 px-2 py-2 min-w-max">
          {allTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => handleTabSelect(tab.sectionId, tab.id)}
              className={`flex items-center justify-center space-x-1 px-3 py-2 text-xs rounded-md transition-colors duration-200 focus:outline-none whitespace-nowrap ${
                selectedTab === tab.id
                  ? 'bg-muted text-text-primary'
                  : 'text-text-muted hover:text-text-primary hover:bg-muted'
              }`}
            >
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Navigation */}
        <TopNavigation activePage="dashboard" variant="standalone" showLogo={true}>
          <GithubStarButton />
          <UserMenu />
        </TopNavigation>

        {/* Dashboard Content */}
        <div className="flex-1 overflow-x-hidden flex flex-col min-h-0">
          <div className="w-full min-w-0 flex-1 flex flex-col min-h-0">
            {isDesktop ? (
              /* Desktop Layout with Tree Menu */
              <div className="flex h-full">
                {/* Left Sidebar with Tree Menu */}
                <div className="w-64 bg-base flex flex-col space-y-1 px-8 py-4 border-r border-border overflow-y-auto">
                  {menuStructure.map(renderDesktopMenuItem)}
                </div>

                {/* Right Content Area */}
                <div className="flex-1 min-h-0 px-8 py-4 min-w-0 flex flex-col overflow-hidden">
                  <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
                    {currentComponent}
                  </div>
                </div>
              </div>
            ) : (
              /* Mobile Layout */
              <div className="flex flex-col h-full">
                {renderMobileMenu()}
                <div className="flex-1 min-h-0 px-2 py-2 overflow-y-auto min-w-0">
                  {currentComponent}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
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
