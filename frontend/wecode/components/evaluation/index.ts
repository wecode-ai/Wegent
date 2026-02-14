// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Evaluation module components
 *
 * Components are organized by role:
 * - common/: Shared components across all roles
 * - author/: Author (topic creator) components
 * - respondent/: Respondent (answer submitter) components
 * - grader/: Grader (reviewer) components
 */

// Common components
export { EvaluationPageLayout } from './common/EvaluationPageLayout'
export { EvaluationFileUpload } from './common/EvaluationFileUpload'
export { StatusBadge } from './common/StatusBadge'
export { VersionBadge } from './common/VersionBadge'
export { VisibilityBadge } from './common/VisibilityBadge'

// Author components
export { TopicCard } from './author/TopicCard'

// Respondent components
export { RespondentTopicCard } from './respondent/RespondentTopicCard'

// Grader components
export { DashboardStats } from './grader/DashboardStats'
export { GradingTaskCard } from './grader/GradingTaskCard'
