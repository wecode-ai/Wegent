// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { WikiProject, WikiGeneration } from '@/types/wiki';
import { getProjectDisplayName } from './wikiUtils';

interface WikiProjectListProps {
  projects: (WikiProject & { generations?: WikiGeneration[] })[];
  loading: boolean;
  loadingMore?: boolean;
  error: string | null;
  onAddRepo: () => void;
  onProjectClick: (projectId: number) => void;
  onCancelClick: (projectId: number, e: React.MouseEvent) => void;
  cancellingIds: Set<number>;
  searchTerm?: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

export default function WikiProjectList({
  projects,
  loading,
  loadingMore = false,
  error,
  onAddRepo,
  onProjectClick,
  onCancelClick,
  cancellingIds,
  searchTerm = '',
  hasMore = false,
  onLoadMore,
}: WikiProjectListProps) {
  const { t } = useTranslation();
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement | null>(null);

  // Setup intersection observer for infinite scroll
  const setupObserver = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    if (!hasMore || !onLoadMore) return;

    observerRef.current = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && onLoadMore) {
          onLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreTriggerRef.current) {
      observerRef.current.observe(loadMoreTriggerRef.current);
    }
  }, [hasMore, loadingMore, onLoadMore]);

  useEffect(() => {
    setupObserver();
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [setupObserver]);
  // Filter projects
  const filteredProjects = projects.filter(project => {
    const matchesSearch =
      project.project_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (project.description &&
        project.description.toLowerCase().includes(searchTerm.toLowerCase())) ||
      project.project_type.toLowerCase().includes(searchTerm.toLowerCase()) ||
      project.source_type.toLowerCase().includes(searchTerm.toLowerCase());

    const hasValidGeneration =
      project.generations &&
      project.generations.length > 0 &&
      (project.generations[0].status === 'RUNNING' ||
        project.generations[0].status === 'COMPLETED' ||
        project.generations[0].status === 'PENDING');

    return matchesSearch && hasValidGeneration;
  });

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error) {
    return <div className="bg-red-50 text-red-500 p-4 rounded-md">{error}</div>;
  }

  if (projects.length === 0) {
    return (
      <div className="text-center py-12 text-text-secondary">
        <p>{t('wiki.no_projects')}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {/* Add repository card */}
      <div
        className="bg-surface border border-border rounded-lg p-6 hover:shadow-lg transition-all duration-200 cursor-pointer flex flex-col items-center justify-center h-[200px]"
        onClick={onAddRepo}
      >
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
          <svg
            className="h-5 w-5 text-primary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </div>
        <h3 className="font-medium text-lg mb-1">{t('wiki.add_repository')}</h3>
        <p className="text-sm text-text-secondary text-center">{t('wiki.add_repository_desc')}</p>
      </div>

      {/* Project card list */}
      {filteredProjects.map(project => (
        <div
          key={project.id}
          className="bg-surface border border-border rounded-lg p-6 hover:shadow-lg transition-all duration-200 cursor-pointer transform hover:-translate-y-1 h-[200px] flex flex-col"
          onClick={() => onProjectClick(project.id)}
        >
          {/* Project header */}
          <div className="flex items-start mb-3 flex-shrink-0">
            <div className="w-6 h-6 mr-3 flex-shrink-0 text-text-secondary mt-0.5">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
            <h3 className="font-semibold text-lg leading-tight line-clamp-2">
              {(() => {
                const displayName = getProjectDisplayName(project);
                if (displayName.hasSlash) {
                  return (
                    <span className="flex items-center flex-wrap">
                      <span className="text-text-muted">{displayName.parts[0]}</span>
                      <span className="mx-1 text-text-muted font-normal">/</span>
                      <span>{displayName.parts[1]}</span>
                    </span>
                  );
                }
                return <span>{displayName.parts[0]}</span>;
              })()}
            </h3>
          </div>

          {/* Project info - takes remaining space */}
          <div className="text-sm text-text-secondary flex-1 min-h-0">
            <p className="flex items-center">
              <span className="text-text-muted mr-2">{t('wiki.source')}:</span>
              <span className="capitalize">{project.source_type}</span>
            </p>
            {project.description && (
              <p className="mt-2 line-clamp-2 text-text-muted">{project.description}</p>
            )}
          </div>

          {/* Wiki generation status - only show when indexing */}
          {project.generations &&
            project.generations.length > 0 &&
            (project.generations[0].status === 'RUNNING' ||
              project.generations[0].status === 'PENDING') && (
              <div className="mt-auto pt-3 border-t border-border flex-shrink-0">
                <div className="flex items-center justify-end">
                  <span
                    className="px-3 py-1 text-xs rounded-full bg-surface-hover text-text-secondary border border-border cursor-pointer hover:bg-muted transition-colors"
                    onClick={e => onCancelClick(project.id, e)}
                    title={t('wiki.cancel_title')}
                  >
                    {cancellingIds.has(project.generations[0].id)
                      ? t('wiki.cancelling')
                      : t('wiki.indexing')}
                  </span>
                </div>
              </div>
            )}
        </div>
      ))}
      {/* Load more trigger - invisible element that triggers loading when scrolled into view */}
      {hasMore && onLoadMore && (
        <div ref={loadMoreTriggerRef} className="col-span-full h-10" />
      )}

      {/* Loading more indicator */}
      {loadingMore && (
        <div className="col-span-full flex justify-center py-4">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
        </div>
      )}
    </div>
  );
}
