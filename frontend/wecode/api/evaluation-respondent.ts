// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client functions for the evaluation respondent module.
 * These APIs are for users who answer questions.
 *
 * NOTE: Respondents CANNOT view any grading status or results.
 * This is a business security requirement to ensure evaluation fairness.
 */

import { fetchJson, getRespondentUrl } from './evaluation-client'
import type {
  Topic,
  TopicListResponse,
  Question,
  QuestionListResponse,
  Answer,
  AnswerCreate,
  AnswerListResponse,
  RespondentProgress,
} from '../types/evaluation'

// ============================================================================
// Topic API (Respondent)
// ============================================================================

export async function respondentListTopics(params: {
  page?: number
  limit?: number
  search?: string
}): Promise<TopicListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.search) searchParams.set('search', params.search)

  return fetchJson<TopicListResponse>(getRespondentUrl(`/topics?${searchParams.toString()}`))
}

export async function respondentGetTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getRespondentUrl(`/topics/${topicId}`))
}

export async function respondentGetProgress(topicId: number): Promise<RespondentProgress> {
  return fetchJson<RespondentProgress>(getRespondentUrl(`/topics/${topicId}/progress`))
}

// ============================================================================
// Question API (Respondent)
// ============================================================================

export async function respondentListQuestions(
  topicId: number,
  params: {
    page?: number
    limit?: number
  }
): Promise<QuestionListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())

  return fetchJson<QuestionListResponse>(
    getRespondentUrl(`/topics/${topicId}/questions?${searchParams.toString()}`)
  )
}

export async function respondentGetQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getRespondentUrl(`/questions/${questionId}`))
}

// ============================================================================
// Answer API (Respondent)
// ============================================================================

export async function respondentSubmitAnswer(
  questionId: number,
  data: AnswerCreate
): Promise<Answer> {
  return fetchJson<Answer>(getRespondentUrl(`/questions/${questionId}/answers`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function respondentGetAnswer(answerId: number): Promise<Answer> {
  return fetchJson<Answer>(getRespondentUrl(`/answers/${answerId}`))
}

export async function respondentListAnswerHistory(params: {
  page?: number
  limit?: number
  topic_id?: number
  question_id?: number
  latest_only?: boolean
}): Promise<AnswerListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.topic_id) searchParams.set('topic_id', params.topic_id.toString())
  if (params.question_id) searchParams.set('question_id', params.question_id.toString())
  if (params.latest_only !== undefined)
    searchParams.set('latest_only', params.latest_only.toString())

  return fetchJson<AnswerListResponse>(getRespondentUrl(`/history?${searchParams.toString()}`))
}

// NOTE: Grading Report APIs have been REMOVED for respondents.
// Respondents cannot view any grading status or results.
// This is a business security requirement to ensure evaluation fairness.
// Grading reports are only visible to Authors and Graders.
