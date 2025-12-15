// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  WizardAnswers,
  FollowUpQuestion,
  ShellRecommendation,
  ModelRecommendation,
} from '@/apis/wizard'

export interface WizardState {
  currentStep: number
  // Step 1: Core answers
  coreAnswers: WizardAnswers
  // Step 2: Follow-up Q&A
  followupRounds: FollowUpRound[]
  currentFollowupRound: number
  isFollowupComplete: boolean
  // Step 3: Recommendations
  shellRecommendation: ShellRecommendation | null
  modelRecommendation: ModelRecommendation | null
  alternativeShells: ShellRecommendation[]
  alternativeModels: ModelRecommendation[]
  // Step 4: Preview/Edit
  systemPrompt: string
  agentName: string
  agentDescription: string
  selectedShell: ShellRecommendation | null
  selectedModel: ModelRecommendation | null
  bindMode: ('chat' | 'code')[]
  icon: string | null
  // General
  isLoading: boolean
  error: string | null
}

export interface FollowUpRound {
  questions: FollowUpQuestion[]
  answers: Record<string, string>
}

export type WizardAction =
  | { type: 'SET_STEP'; step: number }
  | { type: 'SET_CORE_ANSWERS'; answers: Partial<WizardAnswers> }
  | { type: 'SET_FOLLOWUP_QUESTIONS'; questions: FollowUpQuestion[]; roundNumber: number }
  | { type: 'SET_FOLLOWUP_ANSWER'; questionKey: string; answer: string }
  | { type: 'SET_FOLLOWUP_COMPLETE'; isComplete: boolean }
  | { type: 'NEXT_FOLLOWUP_ROUND' }
  | { type: 'SET_RECOMMENDATIONS'; shell: ShellRecommendation; model: ModelRecommendation | null; altShells: ShellRecommendation[]; altModels: ModelRecommendation[] }
  | { type: 'SET_SELECTED_SHELL'; shell: ShellRecommendation }
  | { type: 'SET_SELECTED_MODEL'; model: ModelRecommendation | null }
  | { type: 'SET_GENERATED_PROMPT'; prompt: string; name: string; description: string }
  | { type: 'SET_SYSTEM_PROMPT'; prompt: string }
  | { type: 'SET_AGENT_NAME'; name: string }
  | { type: 'SET_AGENT_DESCRIPTION'; description: string }
  | { type: 'SET_BIND_MODE'; mode: ('chat' | 'code')[] }
  | { type: 'SET_ICON'; icon: string | null }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'RESET' }

export const initialWizardState: WizardState = {
  currentStep: 1,
  coreAnswers: {
    purpose: '',
    knowledge_domain: '',
    interaction_style: '',
    output_format: [],
    constraints: '',
  },
  followupRounds: [],
  currentFollowupRound: 0,
  isFollowupComplete: false,
  shellRecommendation: null,
  modelRecommendation: null,
  alternativeShells: [],
  alternativeModels: [],
  systemPrompt: '',
  agentName: '',
  agentDescription: '',
  selectedShell: null,
  selectedModel: null,
  bindMode: ['chat', 'code'],
  icon: null,
  isLoading: false,
  error: null,
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, currentStep: action.step }
    case 'SET_CORE_ANSWERS':
      return {
        ...state,
        coreAnswers: { ...state.coreAnswers, ...action.answers },
      }
    case 'SET_FOLLOWUP_QUESTIONS': {
      const newRounds = [...state.followupRounds]
      if (action.roundNumber > newRounds.length) {
        newRounds.push({ questions: action.questions, answers: {} })
      } else {
        newRounds[action.roundNumber - 1] = {
          ...newRounds[action.roundNumber - 1],
          questions: action.questions,
        }
      }
      return {
        ...state,
        followupRounds: newRounds,
        currentFollowupRound: action.roundNumber,
      }
    }
    case 'SET_FOLLOWUP_ANSWER': {
      const rounds = [...state.followupRounds]
      const currentRound = rounds[state.currentFollowupRound - 1]
      if (currentRound) {
        currentRound.answers = {
          ...currentRound.answers,
          [action.questionKey]: action.answer,
        }
      }
      return { ...state, followupRounds: rounds }
    }
    case 'SET_FOLLOWUP_COMPLETE':
      return { ...state, isFollowupComplete: action.isComplete }
    case 'NEXT_FOLLOWUP_ROUND':
      return { ...state, currentFollowupRound: state.currentFollowupRound + 1 }
    case 'SET_RECOMMENDATIONS':
      return {
        ...state,
        shellRecommendation: action.shell,
        modelRecommendation: action.model,
        selectedShell: action.shell,
        selectedModel: action.model,
        alternativeShells: action.altShells,
        alternativeModels: action.altModels,
      }
    case 'SET_SELECTED_SHELL':
      return { ...state, selectedShell: action.shell }
    case 'SET_SELECTED_MODEL':
      return { ...state, selectedModel: action.model }
    case 'SET_GENERATED_PROMPT':
      return {
        ...state,
        systemPrompt: action.prompt,
        agentName: action.name,
        agentDescription: action.description,
      }
    case 'SET_SYSTEM_PROMPT':
      return { ...state, systemPrompt: action.prompt }
    case 'SET_AGENT_NAME':
      return { ...state, agentName: action.name }
    case 'SET_AGENT_DESCRIPTION':
      return { ...state, agentDescription: action.description }
    case 'SET_BIND_MODE':
      return { ...state, bindMode: action.mode }
    case 'SET_ICON':
      return { ...state, icon: action.icon }
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading }
    case 'SET_ERROR':
      return { ...state, error: action.error }
    case 'RESET':
      return initialWizardState
    default:
      return state
  }
}
