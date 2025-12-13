// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import TopNavigation from '@/features/layout/TopNavigation';
import TaskSidebar from '@/features/tasks/components/TaskSidebar';
import ResizableSidebar from '@/features/tasks/components/ResizableSidebar';
import CollapsedSidebarButtons from '@/features/tasks/components/CollapsedSidebarButtons';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { paths } from '@/config/paths';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import {
  SearchInput,
  TypeTabs,
  SearchFilters,
  SearchResults,
  EmptyState,
  useSearch,
} from '@/features/search';

function SearchPageContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const { clearAllStreams } = useChatStreamContext();
  const isMobile = useIsMobile();

  // Sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Search state
  const {
    query,
    types,
    sort,
    dateRange,
    results,
    isLoading,
    error,
    setQuery,
    setTypes,
    setSort,
    setDateRange,
  } = useSearch();

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

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    clearAllStreams();
    router.replace(paths.chat.getHref());
  };

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      {/* Responsive resizable sidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="search"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation with title - with bottom border */}
        <div className="border-b border-border">
          <TopNavigation
            activePage="search"
            variant="with-sidebar"
            title={t('search.title')}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          >
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
          </TopNavigation>
        </div>

        {/* Content area - scrollable */}
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-4xl mx-auto">
            {/* Search input */}
            <div className="mb-4">
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder={t('search.placeholder')}
                isSearching={isLoading}
              />
            </div>
            {/* Type tabs and filters - same row */}
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
              <TypeTabs selected={types} onChange={setTypes} facets={results?.facets} />
              <SearchFilters
                sort={sort}
                dateRange={dateRange}
                onSortChange={setSort}
                onDateRangeChange={setDateRange}
              />
            </div>

            {/* Results */}
            {error && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg mb-4">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {!query && !isLoading ? (
              <EmptyState hasQuery={false} />
            ) : results && results.items.length === 0 && !isLoading ? (
              <EmptyState hasQuery={true} query={query} />
            ) : (
              <SearchResults
                items={results?.items || []}
                keyword={query}
                isLoading={isLoading}
                total={results?.total}
              />
            )}

            {/* Pagination hint */}
            {results && results.items.length > 0 && results.total > results.items.length && (
              <div className="mt-6 text-center">
                <p className="text-sm text-text-muted">
                  {t('search.showing_of', {
                    showing: results.items.length,
                    total: results.total,
                  })}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-base flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <SearchPageContent />
    </Suspense>
  );
}
