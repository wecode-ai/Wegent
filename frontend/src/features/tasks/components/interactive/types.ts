// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Type definitions for interactive messages from MCP tools.
 */

export interface InteractiveAttachment {
  name: string
  url: string
  mime_type: string
  size?: number
}

export interface InteractiveFieldOption {
  value: string
  label: string
  recommended?: boolean
}

export interface InteractiveFieldValidation {
  required?: boolean
  min_length?: number
  max_length?: number
  min?: number
  max?: number
  pattern?: string
  pattern_message?: string
}

export interface InteractiveShowCondition {
  field_id: string
  operator: 'equals' | 'not_equals' | 'contains' | 'in'
  value: unknown
}

export type InteractiveFormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'single_choice'
  | 'multiple_choice'
  | 'datetime'

export interface InteractiveFormField {
  field_id: string
  field_type: InteractiveFormFieldType
  label: string
  placeholder?: string
  default_value?: unknown
  options?: InteractiveFieldOption[]
  validation?: InteractiveFieldValidation
  show_when?: InteractiveShowCondition
}

export interface InteractiveFormDefinition {
  title: string
  description?: string
  fields: InteractiveFormField[]
  submit_button_text?: string
}

export interface InteractiveConfirmDefinition {
  title: string
  message: string
  confirm_text?: string
  cancel_text?: string
}

export interface InteractiveSelectOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
}

export interface InteractiveSelectDefinition {
  title: string
  options: InteractiveSelectOption[]
  multiple?: boolean
  description?: string
}

export type InteractiveMessageType = 'text' | 'markdown' | 'form' | 'confirm' | 'select'

export interface InteractiveMessagePayload {
  request_id: string
  message_type: InteractiveMessageType
  content?: string
  attachments?: InteractiveAttachment[]
  form?: InteractiveFormDefinition
  confirm?: InteractiveConfirmDefinition
  select?: InteractiveSelectDefinition
  timestamp: string
}

export interface InteractiveResponsePayload {
  request_id: string
  response_type: 'form_submit' | 'confirm' | 'select'
  data: Record<string, unknown>
  task_id: number
}
