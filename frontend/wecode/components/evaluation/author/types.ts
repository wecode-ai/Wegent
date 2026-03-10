// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Topic, Question, TopicStatistics } from '@wecode/types/evaluation'

/**
 * Props for the TopicHeader component
 */
export interface TopicHeaderProps {
  /** The topic data to display */
  topic: Topic
  /** Callback when back button is clicked */
  onBack: () => void
  /** Callback when edit configuration button is clicked */
  onEditConfig: () => void
  /** Callback when publish button is clicked */
  onPublish?: () => void
  /** Whether the edit button is loading */
  isLoading?: boolean
  /** Whether the publish action is in progress */
  isPublishing?: boolean
}

/**
 * Props for the main page component
 */
export interface AuthorTopicPageProps {
  params: {
    id: string
  }
}

/**
 * Data structure for the unified author topics page
 */
export interface AuthorTopicData {
  topic: Topic | null
  questions: Question[]
  statistics: TopicStatistics | null
}

/**
 * Tab identifiers for the unified page
 */
export type TopicTab = 'questions' | 'permissions' | 'grading' | 'versions' | 'exam-sessions'

/**
 * Badge configuration for topic status display
 */
export interface StatusBadgeConfig {
  variant: 'default' | 'success' | 'error' | 'warning' | 'info' | 'secondary'
  label: string
}

/**
 * Props for the GradingConfigTab component
 */
export interface GradingConfigTabProps {
  /** The topic ID */
  topicId: number
  /** Topic statistics for grading summary */
  statistics: TopicStatistics | null
}

/**
 * Props for the QuickActionsPanel component
 */
export interface QuickActionsPanelProps {
  /** The topic data */
  topic: Topic
  /** The topic ID */
  topicId: number
  /** Topic statistics for summary display */
  statistics: TopicStatistics | null
  /** Callback when topic is updated (e.g., after publish) */
  onTopicUpdate?: (topic: Topic) => void
  /** Callback when a tab should be switched to */
  onSwitchTab?: (tab: TopicTab) => void
}
