// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopNavigation from '@/features/layout/TopNavigation';
import TaskSidebar from '@/features/tasks/components/TaskSidebar';
import ResizableSidebar from '@/features/tasks/components/ResizableSidebar';
import { AdminTabNav, AdminTabId } from '@/features/admin/components/AdminTabNav';
import { ShieldExclamationIcon } from '@heroicons/react/24/outline';
import UserList from '@/features/admin/components/UserList';
import PublicModelList from '@/features/admin/components/PublicModelList';
import SystemConfigPanel from '@/features/admin/components/SystemConfigPanel';
import { UserProvider, useUser } from '@/features/common/UserContext';
import { TaskContextProvider } from '@/features/tasks/contexts/taskContext';
import { ChatStreamProvider } from '@/features/tasks/contexts/chatStreamContext';
import { useTranslation } from '@/hooks/useTranslation';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { Button } from '@/components/ui/button';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';

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
  const isMobile = useIsMobile();

  // Check if user is admin
  const isAdmin = user?.role === 'admin';

  // Get initial tab from URL
  const getInitialTab = (): AdminTabId => {
    const tab = searchParams.get('tab');
    if (tab && ['users', 'public-models', 'system-config'].includes(tab)) {
      return tab as AdminTabId;
    }
    return 'users';
  };

  const [activeTab, setActiveTab] = useState<AdminTabId>(getInitialTab);

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed');
    if (savedCollapsed === 'true') {
      setIsCollapsed(true);
    }
  }, []);

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('task-sidebar-collapsed', String(newValue));
      return newValue;
    });
  };

  // Handle tab change
  const handleTabChange = useCallback(
    (tab: AdminTabId) => {
      setActiveTab(tab);
      router.replace(`?tab=${tab}`);
    },
    [router]
  );

  // Render content based on active tab
  const currentComponent = useMemo(() => {
    switch (activeTab) {
      case 'users':
        return <UserList />;
      case 'public-models':
        return <PublicModelList />;
      case 'system-config':
        return <SystemConfigPanel />;
      default:
        return <UserList />;
    }
  }, [activeTab]);

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
        {/* Resizable sidebar with TaskSidebar */}
        <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="chat"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
          />
        </ResizableSidebar>

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          <TopNavigation
            activePage="dashboard"
            variant="with-sidebar"
            title={t('title')}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          >
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
          </TopNavigation>
          <AccessDenied />
        </div>
      </div>
    );
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Resizable sidebar with TaskSidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="chat"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation */}
        <TopNavigation
          activePage="dashboard"
          variant="with-sidebar"
          title={t('title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
        >
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Tab navigation */}
        <AdminTabNav activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Admin content area */}
        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">{currentComponent}</div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <UserProvider>
      <TaskContextProvider>
        <ChatStreamProvider>
          <Suspense fallback={<div>Loading...</div>}>
            <AdminContent />
          </Suspense>
        </ChatStreamProvider>
      </TaskContextProvider>
    </UserProvider>
  );
}
