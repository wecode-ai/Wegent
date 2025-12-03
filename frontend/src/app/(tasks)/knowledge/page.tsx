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
  WikiSidebarList,
} from '@/features/knowledge';

export default function WikiPage() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { user } = useUser();

  // Use shared Hook to manage all state and logic
  const {
    projects,
    loading,
    error,
    cancellingIds,
    isModalOpen,
    formData,
    formErrors,
    isSubmitting,
    confirmDialogOpen,
    selectedRepo,
    selectedBranch,
    loadProjects,
    handleAddRepo,
    handleCloseModal,
    handleRepoChange,
    handleBranchChange,
    handleLanguageChange,
    handleSubmit,
    handleCancelClick,
    confirmCancelGeneration,
    setConfirmDialogOpen,
    setPendingCancelProjectId,
  } = useWikiProjects({ accountId: user?.id });

  const [sidebarSearchTerm, setSidebarSearchTerm] = useState('');
  const [mainSearchTerm, setMainSearchTerm] = useState('');

  const navigateToWikiDetail = (projectId: number) => {
    router.push(`/knowledge/${projectId}`);
  };

  // Filter sidebar projects
  const filteredSidebarProjects = projects.filter(project => {
    const matchesSearch = project.project_name
      .toLowerCase()
      .includes(sidebarSearchTerm.toLowerCase());

    const hasValidGeneration =
      project.generations &&
      project.generations.length > 0 &&
      (project.generations[0].status === 'RUNNING' ||
        project.generations[0].status === 'COMPLETED' ||
        project.generations[0].status === 'PENDING');

    return matchesSearch && hasValidGeneration;
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
          {/* Left sidebar */}
          <div className="w-64 border-r border-border overflow-y-auto">
            <div className="p-4">
              <h2 className="text-lg font-medium mb-4">{t('wiki.repositories')}</h2>

              {/* Left search box - using shared component */}
              <SearchBox
                value={sidebarSearchTerm}
                onChange={setSidebarSearchTerm}
                placeholder={t('wiki.search')}
                size="sm"
                className="mb-4"
              />

              {/* Sidebar project list - using shared component */}
              <WikiSidebarList
                projects={filteredSidebarProjects}
                loading={loading}
                error={error}
                onProjectClick={navigateToWikiDetail}
              />
            </div>
          </div>

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
              projects={projects}
              loading={loading}
              error={error}
              onAddRepo={handleAddRepo}
              onProjectClick={navigateToWikiDetail}
              onCancelClick={handleCancelClick}
              cancellingIds={cancellingIds}
              searchTerm={mainSearchTerm}
            />
          </div>
        </div>
      </div>

      {/* Add repository modal */}
      <AddRepoModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        formData={formData}
        formErrors={formErrors}
        isSubmitting={isSubmitting}
        onRepoChange={handleRepoChange}
        onBranchChange={handleBranchChange}
        onLanguageChange={handleLanguageChange}
        onSubmit={handleSubmit}
        selectedRepo={selectedRepo}
        selectedBranch={selectedBranch}
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
