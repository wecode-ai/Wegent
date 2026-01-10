// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Form submission types for unified form handling.
 */

// ============================================================
// Enums
// ============================================================

export type FormSubmissionStatus = 'pending' | 'processing' | 'completed' | 'error'

export type FormFieldType =
  | 'single_choice'
  | 'multiple_choice'
  | 'text_input'
  | 'datetime_picker'
  | 'number_input'

// ============================================================
// Form Schema Types
// ============================================================

export interface FormFieldOption {
  value: string
  label: string
  recommended?: boolean
}

export interface FormFieldValidation {
  min?: number
  max?: number
  pattern?: string
  message?: string
}

export interface FormFieldSchema {
  field_id: string
  field_type: FormFieldType
  label: string
  required?: boolean
  options?: FormFieldOption[]
  placeholder?: string
  default_value?: string | string[] | number
  validation?: FormFieldValidation
}

export interface FormSchema {
  action_type: string
  title: string
  description?: string
  fields: FormFieldSchema[]
  submit_label?: string
}

// ============================================================
// Context and Request Types
// ============================================================

export interface FormContext {
  task_id?: number
  subtask_id?: number
  message_id?: number
  team_id?: number
  extra?: Record<string, unknown>
}

export interface FormSubmissionRequest {
  action_type: string
  form_data: Record<string, unknown>
  context: FormContext
}

export interface FormSubmissionResponse {
  submission_id: string
  status: FormSubmissionStatus
  message: string
  result?: Record<string, unknown>
}

export interface FormSubmissionDetail {
  id: string
  action_type: string
  form_data: Record<string, unknown>
  context?: Record<string, unknown>
  status: FormSubmissionStatus
  result?: Record<string, unknown>
  error_message?: string
  created_at: string
  updated_at: string
}

// ============================================================
// Clarification-specific types (for backward compatibility)
// ============================================================

export interface ClarificationAnswer {
  question_id: string
  question_text?: string
  answer_type: 'choice' | 'custom'
  value: string | string[]
  selected_labels?: string | string[]
}

export interface ClarificationFormData {
  answers: ClarificationAnswer[]
}

// ============================================================
// Pipeline confirmation types
// ============================================================

export interface PipelineConfirmationFormData {
  confirmed_prompt: string
  action: 'continue' | 'retry'
}

// ============================================================
// Final prompt types
// ============================================================

export interface FinalPromptFormData {
  final_prompt: string
  team_id?: number
}

// ============================================================
// WebSocket event payloads
// ============================================================

export interface FormSubmittedPayload {
  submission_id: string
  action_type: string
  task_id?: number
  timestamp: string
}

export interface FormProcessingPayload {
  submission_id: string
  action_type: string
  timestamp: string
}

export interface FormCompletedPayload {
  submission_id: string
  action_type: string
  status: 'completed'
  result: Record<string, unknown>
  timestamp: string
}

export interface FormErrorPayload {
  submission_id: string
  action_type: string
  error: string
  error_code?: string
  timestamp: string
}
