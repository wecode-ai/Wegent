// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Exam module components for the evaluation system.
 *
 * This module provides a complete exam answering interface with:
 * - Topic selection cards
 * - Detailed topic views with requirements
 * - File upload sections for deliverables
 * - Timer and progress tracking
 * - Modal dialogs for confirmation and success states
 *
 * @example
 * ```tsx
 * import { ExamPage } from '@wecode/components/evaluation/exam'
 *
 * export default function ExamRoute() {
 *   return <ExamPage />
 * }
 * ```
 */

// Main page component
export { ExamPage } from './ExamPage'

// UI Components
export { DynamicSlotInput } from './DynamicSlotInput'
export { DynamicAnswerUploadZone } from './DynamicAnswerUploadZone'
export { ExamMarkdownContent } from './ExamMarkdownContent'
export type { ExamMarkdownContentProps } from './ExamMarkdownContent'
export { examMarkdownComponents, examMarkdownPlugins } from './ExamMarkdownContent'
export { SlotMarkdownContent } from './SlotMarkdownContent'
export type { SlotMarkdownContentProps } from './SlotMarkdownContent'
export { IconSelector } from './IconSelector'
export type { IconName } from './ExamIcons'

// Exam specific components
export { Icon, Icons } from './ExamIcons'
export { AIAssessmentTopicCard } from './AIAssessmentTopicCard'
export { AIAssessmentTopicDetail } from './AIAssessmentTopicDetail'
export { ExamTopicDetail } from './ExamTopicDetail'
export { ExamHeader } from './ExamHeader'
export { ExamInfoSection } from './ExamInfoSection'
export { BonusItemsSection } from './BonusItemsSection'
export { SubmitSection } from './SubmitSection'
export { ParticipantInfoSection } from './ParticipantInfoSection'
export { CompletedState } from './CompletedState'
export { EndExamConfirmModal } from './EndExamConfirmModal'
export { LeaveExamConfirmModal } from './LeaveExamConfirmModal'
export { TimeWarningModal } from './TimeWarningModal'

// Confirmation modals for submission flow
export { PreviewConfirmModal } from './PreviewConfirmModal'
export { FinalConfirmModal } from './FinalConfirmModal'

// Types
export type { Topic } from './AIAssessmentTopicCard'
export type { DynamicQuestionData, DynamicQuestionDataMap } from './ai-assessment-types'
export {
  createEmptyDynamicQuestionData,
  createInitialDynamicQuestionDataMap,
} from './ai-assessment-types'

// Utilities
export {
  buildDynamicQuestionDataMapFromAnswers,
  getDynamicTotalFileCount,
  hasDynamicRequiredFiles,
  getTimerColorClass,
  extractAttachmentsFromContent,
  extractTextValuesFromContent,
  parseDynamicAnswerData,
} from './ai-assessment-utils'

// Hooks
export { useExamTimer } from './hooks/useExamTimer'
export { useAutoSave } from './hooks/useAutoSave'
