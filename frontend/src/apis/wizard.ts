// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client'

// Types
export interface CoreQuestion {
  key: string
  question: string
  input_type: 'text' | 'single_choice' | 'multiple_choice'
  options?: string[]
  required: boolean
  placeholder?: string
}

export interface WizardAnswers {
  purpose: string
  knowledge_domain?: string
  interaction_style?: string
  output_format?: string[]
  constraints?: string
}

export interface FollowUpQuestion {
  question: string
  input_type: 'text' | 'single_choice' | 'multiple_choice'
  options?: string[]
}

export interface FollowUpResponse {
  questions: FollowUpQuestion[]
  is_complete: boolean
  round_number: number
}

export interface ShellRecommendation {
  shell_name: string
  shell_type: string
  reason: string
  confidence: number
}

export interface ModelRecommendation {
  model_name: string
  model_id?: string
  reason: string
  confidence: number
}

export interface RecommendConfigResponse {
  shell: ShellRecommendation
  model?: ModelRecommendation
  alternative_shells: ShellRecommendation[]
  alternative_models: ModelRecommendation[]
}

export interface GeneratePromptResponse {
  system_prompt: string
  suggested_name: string
  suggested_description: string
}

export interface CreateAllRequest {
  name: string
  description?: string
  system_prompt: string
  shell_name: string
  shell_type: string
  model_name?: string
  model_type?: string
  bind_mode: string[]
  namespace?: string
  icon?: string
}

export interface CreateAllResponse {
  team_id: number
  team_name: string
  bot_id: number
  bot_name: string
  ghost_id: number
  ghost_name: string
  message: string
}

// API functions
export const wizardApis = {
  getCoreQuestions: async (): Promise<{ questions: CoreQuestion[] }> => {
    return apiClient.get('/wizard/core-questions')
  },

  generateFollowUp: async (
    answers: WizardAnswers,
    previousFollowups?: Record<string, string>[],
    roundNumber: number = 1
  ): Promise<FollowUpResponse> => {
    return apiClient.post('/wizard/generate-followup', {
      answers,
      previous_followups: previousFollowups,
      round_number: roundNumber,
    })
  },

  recommendConfig: async (
    answers: WizardAnswers,
    followupAnswers?: Record<string, string>[]
  ): Promise<RecommendConfigResponse> => {
    return apiClient.post('/wizard/recommend-config', {
      answers,
      followup_answers: followupAnswers,
    })
  },

  generatePrompt: async (
    answers: WizardAnswers,
    followupAnswers: Record<string, string>[] | undefined,
    shellType: string,
    modelName?: string
  ): Promise<GeneratePromptResponse> => {
    return apiClient.post('/wizard/generate-prompt', {
      answers,
      followup_answers: followupAnswers,
      shell_type: shellType,
      model_name: modelName,
    })
  },

  createAll: async (request: CreateAllRequest): Promise<CreateAllResponse> => {
    return apiClient.post('/wizard/create-all', request)
  },
}

export default wizardApis
