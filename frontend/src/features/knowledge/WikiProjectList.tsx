// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { WikiProject, WikiGeneration } from '@/types/wiki'
import { getProjectDisplayName } from './wikiUtils'
import { Card } from '@/components/ui/card'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

interface WikiProjectListProps {
  projects: (WikiProject & { generations?: WikiGeneration[] })[]
  loading: boolean
  loadingMore?: boolean
  error: string | null
  onAddRepo: () => void
  onProjectClick: (projectId: number) => void
  onTaskClick: (taskId: number) => void
  onCancelClick: (projectId: number, e: React.MouseEvent) => void
  onDeleteClick?: (projectId: number, e: React.MouseEvent) => void
  onRegenerateClick?: (projectId: number, e: React.MouseEvent) => void
  cancellingIds: Set<number>
  deletingIds?: Set<number>
  regeneratingIds?: Set<number>
  searchTerm?: string
  hasMore?: boolean
  onLoadMore?: () => void
  currentUserId?: number
}

export default function WikiProjectList({
  projects,
  loading,
  loadingMore = false,
  error,
  onAddRepo,
  onProjectClick,
  onTaskClick,
  onCancelClick,
  onDeleteClick,
  onRegenerateClick,
  cancellingIds,
  deletingIds = new Set(),
  regeneratingIds = new Set(),
  searchTerm = '',
  hasMore = false,
  onLoadMore,
  currentUserId,
}: WikiProjectListProps) {
  const { t } = useTranslation()
  const observerRef = useRef<IntersectionObserver | null>(null)
  const loadMoreTriggerRef = useRef<HTMLDivElement | null>(null)

  // Check if add repository feature is enabled (default: true)
  const config = getRuntimeConfigSync()
  // Default to true if not explicitly set to false
  const isAddRepoEnabled = config.enableCodeKnowledgeAddRepo !== false

  // Setup intersection observer for infinite scroll
  const setupObserver = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.disconnect()
    }

    if (!hasMore || !onLoadMore) return

    observerRef.current = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && onLoadMore) {
          onLoadMore()
        }
      },
      { threshold: 0.1 }
    )

    if (loadMoreTriggerRef.current) {
      observerRef.current.observe(loadMoreTriggerRef.current)
    }
  }, [hasMore, loadingMore, onLoadMore])

  useEffect(() => {
    setupObserver()
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
    }
  }, [setupObserver])
  // Filter projects
  const filteredProjects = projects.filter(project => {
    const matchesSearch =
      project.project_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (project.description &&
        project.description.toLowerCase().includes(searchTerm.toLowerCase())) ||
      project.project_type.toLowerCase().includes(searchTerm.toLowerCase()) ||
      project.source_type.toLowerCase().includes(searchTerm.toLowerCase())

    const hasValidGeneration =
      !project.generations ||
      project.generations.length === 0 ||
      (project.generations[0].status !== 'FAILED' && project.generations[0].status !== 'CANCELLED')

    return matchesSearch && hasValidGeneration
  })

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (error) {
    return <div className="bg-red-50 text-red-500 p-4 rounded-md">{error}</div>
  }

  // Empty state - show centered add button
  if (filteredProjects.length === 0) {
    return (
      <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-16">
        <Card
          padding="lg"
          className={`flex flex-col items-center justify-center w-64 h-48 ${
            isAddRepoEnabled
              ? 'hover:bg-hover transition-colors cursor-pointer'
              : 'cursor-not-allowed opacity-60'
          }`}
          onClick={isAddRepoEnabled ? onAddRepo : undefined}
        >
          <div
            className={`w-14 h-14 rounded-full flex items-center justify-center mb-4 ${
              isAddRepoEnabled ? 'bg-primary/10' : 'bg-muted'
            }`}
          >
            <svg
              className={`h-8 w-8 ${isAddRepoEnabled ? 'text-primary' : 'text-text-muted'}`}
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </div>
          <h3
            className={`font-medium text-base mb-2 ${isAddRepoEnabled ? 'text-text-primary' : 'text-text-muted'}`}
          >
            {t('knowledge:add_repository')}
          </h3>
          <p className="text-sm text-text-muted text-center">
            {isAddRepoEnabled
              ? t('knowledge:add_repository_desc_enabled')
              : t('knowledge:add_repository_desc')}
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add repository card */}
        <Card
          padding="sm"
          className={`flex flex-col items-center justify-center h-[140px] ${
            isAddRepoEnabled
              ? 'hover:bg-hover transition-colors cursor-pointer'
              : 'cursor-not-allowed opacity-60'
          }`}
          onClick={isAddRepoEnabled ? onAddRepo : undefined}
        >
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center mb-3 ${
              isAddRepoEnabled ? 'bg-primary/10' : 'bg-muted'
            }`}
          >
            <svg
              className={`h-6 w-6 ${isAddRepoEnabled ? 'text-primary' : 'text-text-muted'}`}
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </div>
          <h3 className={`font-medium text-sm ${isAddRepoEnabled ? '' : 'text-text-muted'}`}>
            {t('knowledge:add_repository')}
          </h3>
          {!isAddRepoEnabled && (
            <p className="text-xs text-text-muted mt-1">{t('knowledge:add_repository_desc')}</p>
          )}
        </Card>

        {/* Project card list */}
        {filteredProjects.map(project => {
          // Check if project is currently generating (RUNNING or PENDING)
          const isGenerating =
            project.generations &&
            project.generations.length > 0 &&
            (project.generations[0].status === 'RUNNING' ||
              project.generations[0].status === 'PENDING')
          const taskId = isGenerating ? project.generations![0].task_id : null
          // Check if current user is the task executor
          const isTaskExecutor =
            isGenerating &&
            currentUserId !== undefined &&
            project.generations![0].user_id === currentUserId

          return (
            <Card
              key={project.id}
              padding="sm"
              className="hover:bg-hover transition-colors cursor-pointer h-[140px] flex flex-col group"
              onClick={() => {
                // Always navigate to wiki detail page when clicking the card
                onProjectClick(project.id)
              }}
            >
              {/* Project header - with top padding */}
              <div className="flex items-start pt-1 mb-2 flex-shrink-0">
                <h3 className="font-medium text-sm leading-relaxed line-clamp-2 flex-1">
                  {(() => {
                    const displayName = getProjectDisplayName(project)
                    if (displayName.hasSlash) {
                      return (
                        <span className="flex items-center flex-wrap">
                          <span className="text-text-muted">{displayName.parts[0]}</span>
                          <span className="mx-1 text-text-muted font-normal">/</span>
                          <span className="font-semibold">{displayName.parts[1]}</span>
                        </span>
                      )
                    }
                    return <span className="font-semibold">{displayName.parts[0]}</span>
                  })()}
                </h3>
              </div>

              {/* Project description - takes remaining space */}
              <div className="text-xs text-text-muted flex-1 min-h-0">
                {project.description && <p className="line-clamp-2">{project.description}</p>}
              </div>

              {/* Bottom section - source on left, actions on right */}
              {!(
                project.generations &&
                project.generations.length > 0 &&
                (project.generations[0].status === 'RUNNING' ||
                  project.generations[0].status === 'PENDING')
              ) && (
                <div className="flex items-center justify-between mt-auto pt-2 flex-shrink-0">
                  {/* Source info - bottom left */}
                  <span className="text-xs text-text-muted capitalize">{project.source_type}</span>
                  {/* Action icons - bottom right */}
                  <div className="flex items-center gap-1">
                    {/* Regenerate button */}
                    {onRegenerateClick && (
                      <button
                        className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
                        onClick={e => onRegenerateClick(project.id, e)}
                        title={t('knowledge:regenerate')}
                        disabled={regeneratingIds.has(project.id)}
                      >
                        {regeneratingIds.has(project.id) ? (
                          <div className="w-4 h-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
                        ) : (
                          <svg
                            className="w-4 h-4"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                          </svg>
                        )}
                      </button>
                    )}
                    {/* Delete button */}
                    {onDeleteClick && (
                      <button
                        className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors opacity-0 group-hover:opacity-100"
                        onClick={e => onDeleteClick(project.id, e)}
                        title={t('common:actions.delete')}
                        disabled={deletingIds.has(project.id)}
                      >
                        {deletingIds.has(project.id) ? (
                          <div className="w-4 h-4 animate-spin rounded-full border-2 border-error border-t-transparent"></div>
                        ) : (
                          <svg
                            className="w-4 h-4"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        )}
                      </button>
                    )}
                    {/* Enter arrow */}
                    <button
                      className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
                      onClick={e => {
                        e.stopPropagation()
                        onProjectClick(project.id)
                      }}
                      title={t('knowledge:view_detail')}
                    >
                      <svg
                        className="w-4 h-4"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M17 8l4 4m0 0l-4 4m4-4H3"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {/* Wiki generation status - only show when indexing */}
              {project.generations &&
                project.generations.length > 0 &&
                (project.generations[0].status === 'RUNNING' ||
                  project.generations[0].status === 'PENDING') && (
                  <div className="mt-auto pt-2 flex-shrink-0">
                    <div className="flex items-center justify-between">
                      {/* Indexing status indicator/button - only clickable if current user is task executor */}
                      {isTaskExecutor ? (
                        <button
                          className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary flex items-center gap-1 hover:bg-primary/20 transition-colors"
                          onClick={e => {
                            e.stopPropagation()
                            if (taskId) {
                              onTaskClick(taskId)
                            }
                          }}
                          title={t('knowledge:view_task')}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
                          {t('knowledge:indexing')}
                        </button>
                      ) : (
                        <span className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
                          {t('knowledge:indexing')}
                        </span>
                      )}
                      {/* Cancel button - only show if current user is task executor */}
                      {isTaskExecutor && (
                        <button
                          className="px-2 py-1 text-xs rounded-full text-text-muted border border-border hover:bg-hover hover:text-error transition-colors"
                          onClick={e => onCancelClick(project.id, e)}
                          title={t('knowledge:cancel_title')}
                          disabled={cancellingIds.has(project.generations[0].id)}
                        >
                          {cancellingIds.has(project.generations[0].id)
                            ? t('knowledge:cancelling')
                            : t('knowledge:cancel')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
            </Card>
          )
        })}
        {/* Load more trigger - invisible element that triggers loading when scrolled into view */}
        {hasMore && onLoadMore && <div ref={loadMoreTriggerRef} className="col-span-full h-10" />}

        {/* Loading more indicator */}
        {loadingMore && (
          <div className="col-span-full flex justify-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
          </div>
        )}
      </div>
    </div>
  )
}
