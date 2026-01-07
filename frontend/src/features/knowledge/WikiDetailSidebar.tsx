// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { WikiGenerationDetail, WikiContent } from '@/types/wiki'
import { getSortedContents } from './wikiUtils'
import { useTranslation } from '@/hooks/useTranslation'

interface WikiDetailSidebarProps {
  wikiDetail: WikiGenerationDetail | null
  loading: boolean
  error: string | null
  selectedContentId: number | null
  onBackToList: () => void
  onSelectContent: (contentId: number) => void
}

/**
 * Wiki detail page sidebar component
 */
export function WikiDetailSidebar({
  wikiDetail,
  loading,
  error,
  selectedContentId,
  onBackToList,
  onSelectContent,
}: WikiDetailSidebarProps) {
  const { t } = useTranslation()

  return (
    <div className="w-64 border-r border-border overflow-y-auto bg-surface/10">
      <div className="p-4 sticky top-0">
        <button
          onClick={onBackToList}
          className="flex items-center text-sm text-primary mb-4 hover:underline"
        >
          <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          {t('knowledge:back_to_list')}
        </button>

        <h2 className="text-lg font-medium mb-2 border-b border-border pb-2">
          {wikiDetail?.project?.source_url ? (
            <a
              href={wikiDetail.project.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary-hover transition-colors duration-200 flex items-center group"
              title="Open repository in new tab"
            >
              <span>{wikiDetail.project.project_name}</span>
              <svg
                className="w-4 h-4 ml-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>
          ) : (
            <span>{wikiDetail?.project?.project_name || t('knowledge:loading')}</span>
          )}
        </h2>

        {wikiDetail?.updated_at && (
          <div className="mb-4 text-xs text-text-muted flex items-center">
            <svg
              className="w-3.5 h-3.5 mr-1.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>
              {t('knowledge:last_indexed')}:{' '}
              {new Date(wikiDetail.updated_at).toLocaleString('en-US', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
          </div>
        ) : error ? (
          <div className="text-red-500 text-sm">{error}</div>
        ) : (
          <ul className="space-y-1">
            {getSortedContents(wikiDetail).map((content: WikiContent) => (
              <li
                key={content.id}
                className={`p-2 rounded-md cursor-pointer transition-colors duration-200 ${
                  selectedContentId === content.id
                    ? 'bg-primary/15 text-primary font-medium border-l-2 border-primary pl-3'
                    : 'hover:bg-surface-hover pl-3.5'
                }`}
                onClick={() => onSelectContent(content.id)}
              >
                <span className="text-sm">{content.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
