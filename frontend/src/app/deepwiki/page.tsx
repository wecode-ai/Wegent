// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import {
  WikiProjectList,
  AddRepoModal,
  useWikiProjects,
  CancelConfirmDialog,
  StandaloneHeader,
  SearchBox,
} from '@/features/knowledge';

export default function DeepWikiPage() {
  const router = useRouter();

  // Use shared Hook to manage all state and logic
  const {
    projects,
    loading,
    loadingMore,
    error,
    cancellingIds,
    hasMore,
    isModalOpen,
    formData,
    formErrors,
    isSubmitting,
    confirmDialogOpen,
    selectedRepo,
    selectedBranch,
    loadProjects,
    loadMoreProjects,
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
  } = useWikiProjects();

  const [searchTerm, setSearchTerm] = useState('');

  const navigateToWikiDetail = (projectId: number) => {
    router.push(`/deepwiki/${projectId}`);
  };

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="min-h-screen bg-base text-text-primary">
      <StandaloneHeader />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Search box - using shared component */}
        <SearchBox
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder="Search projects..."
          size="lg"
          className="mb-8 max-w-2xl mx-auto"
        />

        {/* Project list */}
        <WikiProjectList
          projects={projects}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          onAddRepo={handleAddRepo}
          onProjectClick={navigateToWikiDetail}
          onCancelClick={handleCancelClick}
          cancellingIds={cancellingIds}
          searchTerm={searchTerm}
          hasMore={hasMore}
          onLoadMore={loadMoreProjects}
        />
      </main>

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

      {/* Cancel confirmation dialog */}
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
