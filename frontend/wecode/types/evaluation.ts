/**
 * TypeScript types for the evaluation module.
 */

// Status constants
export const TopicStatus = {
  DRAFT: 0,
  PUBLISHED: 1,
} as const

export const QuestionStatus = {
  DRAFT: 0,
  PUBLISHED: 1,
} as const

export const GradingTaskStatus = {
  PENDING: 0,
  RUNNING: 1,
  COMPLETED: 2,
  FAILED: 3,
  PUBLISHED: 4,
} as const

export const TopicVisibility = {
  PUBLIC: 'public',
  PRIVATE: 'private',
} as const

export const PermissionRole = {
  RESPONDENT: 'respondent',
  GRADER: 'grader',
  QUESTION_CREATOR: 'question_creator',
} as const

export const ContentType = {
  TEXT: 'text',
  URL: 'url',
  ATTACHMENT: 'attachment',
  MIXED: 'mixed',
} as const

// Attachment interface for evaluation module
export interface EvalAttachment {
  key: string
  filename: string
  file_size?: number
  content_type?: string
}

// Content data interface with typed attachments
export interface ContentData {
  text?: string
  url?: string
  attachments?: EvalAttachment[]
}

// Topic types
export interface Topic {
  id: number
  name: string
  creator_id: number
  visibility: string
  status: number
  current_version: string
  extra_data: Record<string, unknown>
  grading_team_config: Record<string, unknown>
  created_at: string
  updated_at: string
  is_active: boolean
  description?: string
  instructions?: string
  question_count?: number
  published_question_count?: number
  creator_name?: string
}

export interface TopicCreate {
  name: string
  description?: string
  instructions?: string
  visibility?: string
  grading_team_id?: number
}

export interface TopicUpdate {
  name?: string
  description?: string
  instructions?: string
  visibility?: string
  grading_team_id?: number
  extra_data?: Record<string, unknown>
}

export interface TopicVersion {
  id: number
  topic_id: number
  version: string
  question_snapshots: QuestionSnapshot[]
  published_at: string
  published_by: number
}

export interface QuestionSnapshot {
  question_id: number
  version: string
  title: string
  order_index: number
}

export interface TopicStatistics {
  total_questions: number
  published_questions: number
  total_answers: number
  total_respondents: number
  grading_pending: number
  grading_completed: number
  grading_published: number
}

// Question types
export interface Question {
  id: number
  topic_id: number
  title: string
  content_type: string
  content_data: Record<string, unknown>
  status: number
  current_version: string
  order_index: number
  creator_id: number
  created_at: string
  updated_at: string
  is_active: boolean
  criteria_type?: string
  criteria_data?: Record<string, unknown>
  has_new_version?: boolean
  latest_version?: string
}

export interface QuestionCreate {
  title: string
  content_type?: string
  content_data?: Record<string, unknown>
  criteria_type?: string
  criteria_data?: Record<string, unknown>
  order_index?: number
}

export interface QuestionUpdate {
  title?: string
  content_type?: string
  content_data?: Record<string, unknown>
  criteria_type?: string
  criteria_data?: Record<string, unknown>
  order_index?: number
}

export interface QuestionVersion {
  id: number
  question_id: number
  version: string
  content_data: Record<string, unknown>
  criteria_data: Record<string, unknown>
  published_at: string
  published_by: number
}

// Permission types
export interface Permission {
  id: number
  topic_id: number
  user_id: number
  role: string
  granted_by: number
  granted_at: string
  user_name?: string
  user_email?: string
}

export interface PermissionCreate {
  user_id: number
  role: string
}

export interface UserRole {
  topic_id: number
  user_id: number
  role: string | null
  can_view: boolean
  can_edit: boolean
  can_answer: boolean
  can_grade: boolean
}

// Answer types
export interface Answer {
  id: number
  question_id: number
  question_version: string
  respondent_id: number
  content_type: string
  content_data: Record<string, unknown>
  submitted_at: string
  is_latest: boolean
  respondent_name?: string
  grading_status?: number
  grading_task_id?: number
}

export interface AnswerCreate {
  content_type?: string
  content_text?: string
  content_data?: Record<string, unknown>
}

export interface VersionCheck {
  has_new_version: boolean
  new_version: string | null
  current_version: string
}

export interface RespondentProgress {
  total_questions: number
  answered_questions: number
  published_reports: number
  completion_rate: number
}

// Grading task types
export interface GradingTask {
  id: number
  answer_id: number
  question_id: number
  question_version: string
  respondent_id: number
  grader_id: number
  team_id: number
  task_id: number
  status: number
  executor_id?: string
  attempt_count?: number
  error_message?: string
  report_data: Record<string, unknown>
  report_s3_path: string
  created_at: string
  started_at?: string
  completed_at?: string
  published_at?: string
  respondent_name?: string
  question_title?: string
  topic_id?: number
  topic_name?: string
  submitted_at?: string
}

export interface GradingTaskExecuteRequest {
  team_id?: number
}

export interface GradingTaskPublishRequest {
  report_content?: string
}

export interface GradingTaskUpdateReportRequest {
  report_content: string
}

// Grading configuration types
export interface GradingConfig {
  team_id?: number
  auto_trigger: boolean
  trigger_condition: string
  grading_timeout: number
  team_name?: string
  team_valid?: boolean
}

export interface GradingConfigUpdate {
  team_id?: number
  auto_trigger?: boolean
  trigger_condition?: string
  grading_timeout?: number
}

// List response types
export interface ListResponse<T> {
  total: number
  items: T[]
}

export type TopicListResponse = ListResponse<Topic>
export type QuestionListResponse = ListResponse<Question>
export type PermissionListResponse = ListResponse<Permission>
export type AnswerListResponse = ListResponse<Answer>
export type GradingTaskListResponse = ListResponse<GradingTask>

// Helper functions
export function getStatusLabel(
  status: number,
  type: 'topic' | 'question' | 'grading',
  t?: (key: string) => string
): string {
  if (type === 'grading') {
    switch (status) {
      case GradingTaskStatus.PENDING:
        return t ? t('grading.status.pending') : 'Pending'
      case GradingTaskStatus.RUNNING:
        return t ? t('grading.status.running') : 'Running'
      case GradingTaskStatus.COMPLETED:
        return t ? t('grading.status.completed') : 'Completed'
      case GradingTaskStatus.FAILED:
        return t ? t('grading.status.failed') : 'Failed'
      case GradingTaskStatus.PUBLISHED:
        return t ? t('grading.status.published') : 'Published'
      default:
        return 'Unknown'
    }
  }

  switch (status) {
    case TopicStatus.DRAFT:
      return t ? t('topics.unpublished') : 'Draft'
    case TopicStatus.PUBLISHED:
      return t ? t('topics.published') : 'Published'
    default:
      return 'Unknown'
  }
}

export function getVisibilityLabel(visibility: string, t?: (key: string) => string): string {
  switch (visibility) {
    case TopicVisibility.PUBLIC:
      return t ? t('topics.public') : 'Public'
    case TopicVisibility.PRIVATE:
      return t ? t('topics.private') : 'Private'
    default:
      return visibility
  }
}

export function getRoleLabel(role: string): string {
  switch (role) {
    case PermissionRole.RESPONDENT:
      return 'Respondent'
    case PermissionRole.GRADER:
      return 'Grader'
    case PermissionRole.QUESTION_CREATOR:
      return 'Question Creator'
    case 'creator':
      return 'Creator'
    default:
      return role
  }
}
