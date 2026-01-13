// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GitRepoInfo, TaskDetail } from '@/types/api'

/**
 * Props for RepositorySelector component
 */
export interface RepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  handleRepoChange: (repo: GitRepoInfo | null) => void
  disabled: boolean
  selectedTaskDetail?: TaskDetail | null
  /** When true, the selector will take full width of its container */
  fullWidth?: boolean
  /** When true, display only icon without text (for responsive collapse) */
  compact?: boolean
}

/**
 * Item format for searchable select
 */
export interface RepositorySelectItem {
  value: string
  label: string
  searchText: string
}

/**
 * Props for RepositorySelectorFooter component
 */
export interface RepositorySelectorFooterProps {
  onConfigureClick: () => void
  onRefreshClick: () => void
  isRefreshing: boolean
}
