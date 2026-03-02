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
export { TopicCard } from './TopicCard'
export { TopicDetail } from './TopicDetail'
export { FileUploadSection } from './FileUploadSection'
export { ConfirmModal } from './ConfirmModal'
export { SuccessModal } from './SuccessModal'
export { SlotBasedFileUpload } from './SlotBasedFileUpload'

// AI Assessment specific components
export { Icon, Icons } from './ExamIcons'
export { AIAssessmentTopicCard } from './AIAssessmentTopicCard'
export { AIAssessmentTopicDetail } from './AIAssessmentTopicDetail'
export { ExamHeader } from './ExamHeader'
export { ExamInfoSection } from './ExamInfoSection'
export { BonusItemsSection } from './BonusItemsSection'
export { SupplementaryNotesSection } from './SupplementaryNotesSection'
export { SubmitSection } from './SubmitSection'
export { ParticipantInfoSection } from './ParticipantInfoSection'
export { CompletedState } from './CompletedState'
export { EndExamConfirmModal } from './EndExamConfirmModal'
export { LeaveExamConfirmModal } from './LeaveExamConfirmModal'

// Types
export type { Topic } from './AIAssessmentTopicCard'

// Hooks
export { useExamTimer } from './hooks/useExamTimer'
export { useExamState } from './hooks/useExamState'
