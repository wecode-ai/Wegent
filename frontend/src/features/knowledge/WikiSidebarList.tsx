// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { WikiProject } from '@/types/wiki'
import { getProjectDisplayName } from './wikiUtils'

interface WikiSidebarListProps {
  projects: WikiProject[]
  loading: boolean
  error: string | null
  onProjectClick: (projectId: number) => void
}

/**
 * Wiki sidebar project list component
 * Displays project list with click navigation
 */
export function WikiSidebarList({
  projects,
  loading,
  error,
  onProjectClick,
}: WikiSidebarListProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (error) {
    return <div className="text-red-500 text-sm">{error}</div>
  }

  return (
    <ul className="space-y-2">
      {projects.map(project => (
        <li
          key={project.id}
          className="p-2 rounded-md hover:bg-surface-hover cursor-pointer flex items-start"
          onClick={() => onProjectClick(project.id)}
        >
          <div className="w-5 h-5 mr-2 flex-shrink-0 text-text-secondary mt-0.5">
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
          <span className="min-w-0 break-words text-sm leading-relaxed">
            {(() => {
              const displayName = getProjectDisplayName(project)
              if (displayName.hasSlash) {
                return (
                  <>
                    <span className="text-text-muted">{displayName.parts[0]}</span>
                    <span className="text-text-muted"> / </span>
                    <span>{displayName.parts[1]}</span>
                  </>
                )
              }
              return displayName.parts[0]
            })()}
          </span>
        </li>
      ))}
    </ul>
  )
}
