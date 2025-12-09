// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import TopNavigation from '@/features/layout/TopNavigation';
import UserMenu from '@/features/layout/UserMenu';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { useTranslation } from '@/hooks/useTranslation';
import { saveLastTab } from '@/utils/userPreferences';
import { useUser } from '@/features/common/UserContext';
import {
  WikiProjectList,
  AddRepoModal,
  useWikiProjects,
  CancelConfirmDialog,
  SearchBox,
  KnowledgeModuleNav,
} from '@/features/knowledge';

export default function WikiPage() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { user } = useUser();

  // Use shared Hook to manage all state and logic
  const {
    projects,
    loading,
    loadingMore,
    error,
    cancellingIds,
    hasMore,
    isModalOpen,
    formErrors,
    isSubmitting,
    confirmDialogOpen,
    selectedRepo,
    // Wiki config state (system-level configuration)
    wikiConfig,
    loadProjects,
    loadMoreProjects,
    handleAddRepo,
    handleCloseModal,
    handleRepoChange,
    handleSubmit,
    handleCancelClick,
    confirmCancelGeneration,
    setConfirmDialogOpen,
    setPendingCancelProjectId,
  } = useWikiProjects();

  const [mainSearchTerm, setMainSearchTerm] = useState('');

  const navigateToWikiDetail = (projectId: number) => {
    router.push(`/knowledge/${projectId}`);
  };

  const navigateToTask = (taskId: number) => {
    router.push(`/code?taskId=${taskId}`);
  };

  // Filter projects to show only those with user's generations
  // This ensures the knowledge page only shows projects created by the current user
  const userProjects = projects.filter(project => {
    // Check if user has any generations for this project
    return (
      project.generations &&
      project.generations.length > 0 &&
      (project.generations[0].status === 'RUNNING' ||
        project.generations[0].status === 'COMPLETED' ||
        project.generations[0].status === 'PENDING' ||
        project.generations[0].status === 'FAILED' ||
        project.generations[0].status === 'CANCELLED')
    );
  });

  useEffect(() => {
    saveLastTab('wiki');
  }, []);

  useEffect(() => {
    if (!user) return;
    loadProjects();
  }, [user, loadProjects]);

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      <div className="flex-1 flex flex-col min-w-0">
        <TopNavigation activePage="wiki" variant="standalone">
          <GithubStarButton />
          <UserMenu />
        </TopNavigation>

        <div className="flex h-full">
          {/* Left module navigation sidebar */}
          <KnowledgeModuleNav activeModule="code" />

          {/* Main content area */}
          <div className="flex-1 overflow-auto p-6">
            {/* Center search box - using shared component */}
            <SearchBox
              value={mainSearchTerm}
              onChange={setMainSearchTerm}
              placeholder={t('wiki.search_repositories')}
              size="md"
              className="mb-6 max-w-2xl mx-auto"
            />
            {/* Project list */}
            <WikiProjectList
              projects={userProjects}
              loading={loading}
              loadingMore={loadingMore}
              error={error}
              onAddRepo={handleAddRepo}
              onProjectClick={navigateToWikiDetail}
              onTaskClick={navigateToTask}
              onCancelClick={handleCancelClick}
              cancellingIds={cancellingIds}
              searchTerm={mainSearchTerm}
              hasMore={hasMore}
              onLoadMore={loadMoreProjects}
              currentUserId={user?.id}
            />
          </div>
        </div>
      </div>

      {/* Add repository modal */}
      <AddRepoModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        formErrors={formErrors}
        isSubmitting={isSubmitting}
        onRepoChange={handleRepoChange}
        onSubmit={handleSubmit}
        selectedRepo={selectedRepo}
        wikiConfig={wikiConfig}
      />
      {/* Cancel confirm dialog */}
      <CancelConfirmDialog
        isOpen={confirmDialogOpen}
        onClose={() => {
          setConfirmDialogOpen(false);
          setPendingCancelProjectId(null);
        }}
        onConfirm={confirmCancelGeneration}
      />
    </div>
  );
}
