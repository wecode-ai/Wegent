// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Form submission API client.
 *
 * Provides methods for unified form submission and retrieval.
 */

import { apiClient } from './client'
import {
  FormSubmissionRequest,
  FormSubmissionResponse,
  FormSubmissionDetail,
  ClarificationFormData,
  PipelineConfirmationFormData,
  FinalPromptFormData,
  FormContext,
} from '../types/form'

/**
 * Submit a form to the unified form submission endpoint.
 */
export async function submitForm(
  request: FormSubmissionRequest
): Promise<FormSubmissionResponse> {
  return apiClient.post<FormSubmissionResponse>('/forms/submit', request)
}

/**
 * Get a form submission by ID.
 */
export async function getSubmission(
  submissionId: string
): Promise<FormSubmissionDetail> {
  return apiClient.get<FormSubmissionDetail>(`/forms/submissions/${submissionId}`)
}

/**
 * List form submissions for the current user.
 */
export async function listSubmissions(params?: {
  action_type?: string
  task_id?: number
  limit?: number
}): Promise<FormSubmissionDetail[]> {
  const queryParams = new URLSearchParams()
  if (params?.action_type) queryParams.set('action_type', params.action_type)
  if (params?.task_id) queryParams.set('task_id', params.task_id.toString())
  if (params?.limit) queryParams.set('limit', params.limit.toString())

  const queryString = queryParams.toString()
  const url = queryString ? `/forms/submissions?${queryString}` : '/forms/submissions'
  return apiClient.get<FormSubmissionDetail[]>(url)
}

/**
 * Get available form action types.
 */
export async function getActionTypes(): Promise<{ action_types: string[] }> {
  return apiClient.get<{ action_types: string[] }>('/forms/action-types')
}

// ============================================================
// Convenience methods for specific form types
// ============================================================

/**
 * Submit clarification answers.
 */
export async function submitClarification(
  formData: ClarificationFormData,
  context: FormContext
): Promise<FormSubmissionResponse> {
  return submitForm({
    action_type: 'clarification',
    form_data: formData as unknown as Record<string, unknown>,
    context,
  })
}

/**
 * Submit pipeline stage confirmation.
 */
export async function submitPipelineConfirmation(
  formData: PipelineConfirmationFormData,
  context: FormContext
): Promise<FormSubmissionResponse> {
  return submitForm({
    action_type: 'pipeline_confirmation',
    form_data: formData as unknown as Record<string, unknown>,
    context,
  })
}

/**
 * Submit final prompt confirmation.
 */
export async function submitFinalPrompt(
  formData: FinalPromptFormData,
  context: FormContext
): Promise<FormSubmissionResponse> {
  return submitForm({
    action_type: 'final_prompt',
    form_data: formData as unknown as Record<string, unknown>,
    context,
  })
}

// Export all methods as formApis object for convenience
export const formApis = {
  submit: submitForm,
  getSubmission,
  listSubmissions,
  getActionTypes,
  submitClarification,
  submitPipelineConfirmation,
  submitFinalPrompt,
}

export default formApis
