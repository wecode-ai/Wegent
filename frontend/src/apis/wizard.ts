// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client'
import { getToken } from './user'

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
  // Input/Output example fields for better understanding user needs
  example_input?: string
  expected_output?: string
  special_requirements?: string
  // Legacy fields for backward compatibility
  example_task?: string
  knowledge_domain?: string
  interaction_style?: string
  output_format?: string[]
  constraints?: string
}

export interface FollowUpQuestion {
  question: string
  input_type: 'text' | 'single_choice' | 'multiple_choice'
  options?: string[]
  default_answer?: string // AI-suggested default answer
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
  sample_test_message: string
}

export interface TestPromptRequest {
  system_prompt: string
  test_message: string
  model_name?: string
}

export interface TestPromptResponse {
  response: string
  success: boolean
}

export interface IteratePromptRequest {
  current_prompt: string
  test_message: string
  model_response: string
  user_feedback: string
  selected_text?: string // Text selected by user from model_response
  model_name?: string
}

export interface IteratePromptResponse {
  improved_prompt: string
  changes_summary: string
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

  testPrompt: async (
    systemPrompt: string,
    testMessage: string,
    modelName?: string
  ): Promise<TestPromptResponse> => {
    return apiClient.post('/wizard/test-prompt', {
      system_prompt: systemPrompt,
      test_message: testMessage,
      model_name: modelName,
    })
  },

  /**
   * Test a system prompt with streaming response.
   * Returns an async generator that yields content chunks.
   */
  testPromptStream: async function* (
    systemPrompt: string,
    testMessage: string,
    modelName?: string,
    onChunk?: (content: string) => void
  ): AsyncGenerator<string, string, unknown> {
    const token = getToken()
    const response = await fetch('/api/wizard/test-prompt/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        system_prompt: systemPrompt,
        test_message: testMessage,
        model_name: modelName,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || 'Failed to test prompt')
    }

    if (!response.body) {
      throw new Error('No response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullContent = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.error) {
                throw new Error(data.error)
              }
              if (data.content) {
                fullContent += data.content
                onChunk?.(data.content)
                yield data.content
              }
              if (data.done) {
                return fullContent
              }
            } catch (e) {
              // Ignore JSON parse errors for incomplete chunks
              if (e instanceof SyntaxError) continue
              throw e
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    return fullContent
  },
  iteratePrompt: async (
    currentPrompt: string,
    testMessage: string,
    modelResponse: string,
    userFeedback: string,
    modelName?: string,
    selectedText?: string
  ): Promise<IteratePromptResponse> => {
    return apiClient.post('/wizard/iterate-prompt', {
      current_prompt: currentPrompt,
      test_message: testMessage,
      model_response: modelResponse,
      user_feedback: userFeedback,
      selected_text: selectedText,
      model_name: modelName,
    })
  },
}

export default wizardApis
