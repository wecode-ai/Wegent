/**
 * TypeScript types for the evaluation exam module.
 *
 * This module implements the "Topic as Exam Container" pattern where:
 * - Topic.extra_data stores exam configuration (ExamTopicExtraData)
 * - Answer.content_data stores exam submissions (ExamAnswerContent)
 */

/**
 * Exam duration configuration in minutes (three-phase exam flow)
 * - intro: Pre-exam introduction and Q&A (default 5 min)
 * - exam: Main exam answering time (default 50 min)
 * - review: Final review and submission check (default 5 min)
 */
export interface ExamDuration {
  /** Pre-exam introduction duration in minutes */
  intro: number
  /** Main exam answering duration in minutes */
  exam: number
  /** Final review duration in minutes */
  review: number
}

/**
 * Exam configuration stored in Topic.extra_data
 * Enables exam mode for a topic with essential exam settings
 */
export interface ExamTopicExtraData {
  /** Duration configuration */
  duration: ExamDuration
  /** Instructions markdown content */
  instructions: string
}

/**
 * Exam attachment metadata
 */
export interface ExamAttachment {
  /** Unique file key */
  key: string
  /** Display filename */
  filename: string
  /** File size in bytes */
  size: number
  /** MIME type (optional) */
  content_type?: string
}

/**
 * Grouped attachments for exam submission
 */
export interface ExamAttachmentGroup {
  /** Main deliverable attachments */
  main: ExamAttachment[]
  /** Interaction design attachments */
  interaction: ExamAttachment[]
  /** Bonus: Agent deployment */
  bonusAgent: {
    /** Deployment link */
    link?: string
    /** Supporting files */
    files: ExamAttachment[]
  }
  /** Bonus: Multimodal attachments */
  bonusMultimodal: ExamAttachment[]
}

/**
 * Exam answer content stored in Answer.content_data
 * Contains participant submission with all attachments
 */
export interface ExamAnswerContent {
  /** Participant's name */
  participantName: string
  /** Selected topic ID (for validation) */
  selectedTopicId: number
  /** Additional notes from participant */
  supplementaryNotes: string
  /** Grouped file attachments */
  attachments: ExamAttachmentGroup
  /** Supplementary notes as file attachments (for multiple versions) */
  supplementaryNotesFiles?: ExamAttachment[]
}

/**
 * Exam phase states (three-phase exam flow)
 * - intro: Pre-exam introduction and Q&A (default 5 min)
 * - exam: Main exam answering time (default 50 min)
 * - review: Final review and submission check (default 5 min)
 * - completed: Time expired, no more submissions allowed
 */
export type ExamPhase = 'intro' | 'exam' | 'review' | 'completed'

/**
 * Exam session status from server (three-phase exam flow)
 * Contains timing information and current phase
 */
export interface ExamSessionStatus {
  /** Current phase: intro, exam, review, or completed */
  phase: 'intro' | 'exam' | 'review' | 'completed'
  /** ISO timestamp when exam started */
  started_at: string
  /** ISO timestamp when intro phase ends */
  intro_end_at: string
  /** ISO timestamp when exam phase ends */
  exam_end_at: string
  /** ISO timestamp when review phase ends */
  review_end_at: string
  /** Remaining seconds in current phase (negative when overtime) */
  remaining_seconds: number
  /** Whether current phase time has expired (remaining_seconds < 0) */
  is_overtime: boolean
  /** Number of submissions made */
  submit_count: number
  /** Selected question ID (null if not selected) */
  selected_question_id: number | null
}

/**
 * Exam data response from server
 */
export interface ExamDataResponse {
  topic: {
    id: number
    name: string
    creator_id: number
    visibility: string
    status: string
    current_version: string
    extra_data: ExamTopicExtraData
    created_at: string
    updated_at: string
    is_active: boolean
  }
  questions: ExamQuestion[]
  userAnswer: ExamAnswer | null
  session: ExamSessionStatus
}

/**
 * Exam question
 */
export interface ExamQuestion {
  id: number
  topic_id: number
  title: string
  content_type: string
  content_data: Record<string, unknown>
  status: string
  current_version: string
  order_index: number
  creator_id: number
  created_at: string
  updated_at: string
  is_active: boolean
}

/**
 * Exam answer
 */
export interface ExamAnswer {
  id: number
  question_id: number
  question_version: string
  respondent_id: number
  content_type: string
  content_data: ExamAnswerContent
  submitted_at: string
  is_latest: boolean
}

/**
 * Progress step for exam navigation
 */
export interface ExamProgressStep {
  /** Step label */
  label: string
  /** Whether this step is completed */
  done: boolean
}

// Component Props Interfaces

/**
 * Props for the main exam page component
 */
export interface ExamPageProps {
  /** Topic ID for the exam */
  topicId: number
}

/**
 * Props for the exam header component
 */
export interface ExamHeaderProps {
  /** Exam title */
  title: string
  /** Exam year/season */
  year: string
  /** Logo text to display */
  logoText: string
  /** Current exam phase */
  examPhase: ExamPhase
  /** Time left in seconds */
  timeLeft: number
  /** Progress steps for navigation */
  progressSteps: ExamProgressStep[]
}
