// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  WizardAnswers,
  FollowUpQuestion,
  ShellRecommendation,
  ModelRecommendation,
} from '@/apis/wizard'

export interface TestConversation {
  testMessage: string
  modelResponse: string
  userFeedback: string
}

export interface WizardState {
  currentStep: number
  // Step 1: Core answers
  coreAnswers: WizardAnswers
  // Track the core answers when questions were generated (for change detection)
  lastGeneratedCoreAnswers: WizardAnswers | null
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
  sampleTestMessage: string
  // Step 4: Test conversation
  testConversations: TestConversation[]
  isTestingPrompt: boolean
  isIteratingPrompt: boolean
  promptRefreshed: boolean
  // General
  isLoading: boolean
  error: string | null
}

export interface FollowUpRound {
  questions: FollowUpQuestion[]
  answers: Record<string, string>
  additionalThoughts?: string
}

export type WizardAction =
  | { type: 'SET_STEP'; step: number }
  | { type: 'SET_CORE_ANSWERS'; answers: Partial<WizardAnswers> }
  | { type: 'SET_FOLLOWUP_QUESTIONS'; questions: FollowUpQuestion[]; roundNumber: number }
  | { type: 'SET_FOLLOWUP_ANSWER'; questionKey: string; answer: string }
  | {
      type: 'SET_HISTORICAL_FOLLOWUP_ANSWER'
      roundIndex: number
      questionKey: string
      answer: string
    }
  | { type: 'SET_HISTORICAL_ADDITIONAL_THOUGHTS'; roundIndex: number; thoughts: string }
  | { type: 'SET_ADDITIONAL_THOUGHTS'; thoughts: string }
  | { type: 'SET_FOLLOWUP_COMPLETE'; isComplete: boolean }
  | { type: 'NEXT_FOLLOWUP_ROUND' }
  | {
      type: 'SET_RECOMMENDATIONS'
      shell: ShellRecommendation
      model: ModelRecommendation | null
      altShells: ShellRecommendation[]
      altModels: ModelRecommendation[]
    }
  | { type: 'SET_SELECTED_SHELL'; shell: ShellRecommendation }
  | { type: 'SET_SELECTED_MODEL'; model: ModelRecommendation | null }
  | {
      type: 'SET_GENERATED_PROMPT'
      prompt: string
      name: string
      description: string
      sampleTestMessage: string
    }
  | { type: 'SET_SYSTEM_PROMPT'; prompt: string }
  | { type: 'SET_AGENT_NAME'; name: string }
  | { type: 'SET_AGENT_DESCRIPTION'; description: string }
  | { type: 'SET_BIND_MODE'; mode: ('chat' | 'code')[] }
  | { type: 'SET_ICON'; icon: string | null }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_TESTING_PROMPT'; isTestingPrompt: boolean }
  | { type: 'SET_ITERATING_PROMPT'; isIteratingPrompt: boolean }
  | { type: 'SET_PROMPT_REFRESHED'; refreshed: boolean }
  | { type: 'ADD_TEST_CONVERSATION'; conversation: TestConversation }
  | { type: 'UPDATE_LAST_TEST_RESPONSE'; response: string }
  | { type: 'UPDATE_LAST_TEST_FEEDBACK'; feedback: string }
  | { type: 'CLEAR_TEST_CONVERSATIONS' }
  | { type: 'CLEAR_FOLLOWUP_DATA' }
  | { type: 'SAVE_CORE_ANSWERS_SNAPSHOT'; answers: WizardAnswers }
  | { type: 'RESET' }

// Default Chat Shell configuration
const defaultChatShell: ShellRecommendation = {
  shell_name: 'chat',
  shell_type: 'Chat',
  confidence: 1.0,
  reason: 'Default chat assistant',
}

export const initialWizardState: WizardState = {
  currentStep: 1,
  coreAnswers: {
    purpose: '',
    example_input: '',
    expected_output: '',
    special_requirements: '',
    knowledge_domain: '',
    interaction_style: '',
    output_format: [],
    constraints: '',
  },
  lastGeneratedCoreAnswers: null,
  followupRounds: [],
  currentFollowupRound: 0,
  isFollowupComplete: false,
  shellRecommendation: defaultChatShell,
  modelRecommendation: null,
  alternativeShells: [],
  alternativeModels: [],
  systemPrompt: '',
  agentName: '',
  agentDescription: '',
  selectedShell: defaultChatShell,
  selectedModel: null,
  bindMode: ['chat'],
  icon: null,
  sampleTestMessage: '',
  testConversations: [],
  isTestingPrompt: false,
  isIteratingPrompt: false,
  promptRefreshed: false,
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
      // Pre-populate answers with default_answer from questions
      const defaultAnswers: Record<string, string> = {}
      action.questions.forEach(q => {
        const questionKey = `${q.question.substring(0, 30)}`
        if (q.default_answer) {
          defaultAnswers[questionKey] = q.default_answer
        }
      })
      if (action.roundNumber > newRounds.length) {
        newRounds.push({ questions: action.questions, answers: defaultAnswers })
      } else {
        newRounds[action.roundNumber - 1] = {
          ...newRounds[action.roundNumber - 1],
          questions: action.questions,
          answers: { ...defaultAnswers, ...newRounds[action.roundNumber - 1]?.answers },
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
    case 'SET_ADDITIONAL_THOUGHTS': {
      const rounds = [...state.followupRounds]
      const currentRound = rounds[state.currentFollowupRound - 1]
      if (currentRound) {
        currentRound.additionalThoughts = action.thoughts
      }
      return { ...state, followupRounds: rounds }
    }
    case 'SET_HISTORICAL_FOLLOWUP_ANSWER': {
      const rounds = [...state.followupRounds]
      const targetRound = rounds[action.roundIndex]
      if (targetRound) {
        targetRound.answers = {
          ...targetRound.answers,
          [action.questionKey]: action.answer,
        }
      }
      return { ...state, followupRounds: rounds }
    }
    case 'SET_HISTORICAL_ADDITIONAL_THOUGHTS': {
      const rounds = [...state.followupRounds]
      const targetRound = rounds[action.roundIndex]
      if (targetRound) {
        targetRound.additionalThoughts = action.thoughts
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
        sampleTestMessage: action.sampleTestMessage,
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
    case 'SET_TESTING_PROMPT':
      return { ...state, isTestingPrompt: action.isTestingPrompt }
    case 'SET_ITERATING_PROMPT':
      return { ...state, isIteratingPrompt: action.isIteratingPrompt }
    case 'SET_PROMPT_REFRESHED':
      return { ...state, promptRefreshed: action.refreshed }
    case 'ADD_TEST_CONVERSATION':
      return {
        ...state,
        testConversations: [...state.testConversations, action.conversation],
      }
    case 'UPDATE_LAST_TEST_RESPONSE': {
      if (state.testConversations.length === 0) return state
      const conversations = [...state.testConversations]
      conversations[conversations.length - 1] = {
        ...conversations[conversations.length - 1],
        modelResponse: action.response,
      }
      return { ...state, testConversations: conversations }
    }
    case 'UPDATE_LAST_TEST_FEEDBACK': {
      if (state.testConversations.length === 0) return state
      const conversations = [...state.testConversations]
      conversations[conversations.length - 1] = {
        ...conversations[conversations.length - 1],
        userFeedback: action.feedback,
      }
      return { ...state, testConversations: conversations }
    }
    case 'CLEAR_TEST_CONVERSATIONS':
      return { ...state, testConversations: [] }
    case 'CLEAR_FOLLOWUP_DATA':
      // Clear all follow-up related data when core answers change
      return {
        ...state,
        followupRounds: [],
        currentFollowupRound: 0,
        isFollowupComplete: false,
        systemPrompt: '',
        agentName: '',
        agentDescription: '',
        sampleTestMessage: '',
        testConversations: [],
        lastGeneratedCoreAnswers: null,
      }
    case 'SAVE_CORE_ANSWERS_SNAPSHOT':
      // Save a snapshot of core answers when generating questions
      return { ...state, lastGeneratedCoreAnswers: { ...action.answers } }
    case 'RESET':
      return initialWizardState
    default:
      return state
  }
}
