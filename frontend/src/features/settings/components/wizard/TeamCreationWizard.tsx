// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useReducer } from 'react'
import { Loader2, Wand2, ArrowLeft, ArrowRight, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { wizardApis } from '@/apis/wizard'
import type { WizardAnswers, ModelRecommendation } from '@/apis/wizard'

import WizardStepIndicator from './WizardStepIndicator'
import { wizardReducer, initialWizardState } from './types'
import CoreQuestionsStep from './steps/CoreQuestionsStep'
import AiFollowUpStep from './steps/AiFollowUpStep'
import PreviewAdjustStep from './steps/PreviewAdjustStep'
import PromptPreviewStep from './steps/PromptPreviewStep'

const TOTAL_STEPS = 4

interface TeamCreationWizardProps {
  open: boolean
  onClose: () => void
  onSuccess: (teamId: number, teamName: string) => void
  scope?: 'personal' | 'group'
  groupName?: string
}

export default function TeamCreationWizard({
  open,
  onClose,
  onSuccess,
  scope = 'personal',
  groupName,
}: TeamCreationWizardProps) {
  const { t } = useTranslation(['common', 'wizard'])
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState)

  const handleClose = useCallback(() => {
    dispatch({ type: 'RESET' })
    onClose()
  }, [onClose])

  // Core questions change handler
  const handleCoreAnswersChange = useCallback((answers: Partial<WizardAnswers>) => {
    dispatch({ type: 'SET_CORE_ANSWERS', answers })
  }, [])

  // Follow-up answer change handler - supports editing any round
  const handleFollowupAnswerChange = useCallback(
    (questionKey: string, answer: string, roundIndex?: number) => {
      if (roundIndex !== undefined) {
        dispatch({ type: 'SET_HISTORICAL_FOLLOWUP_ANSWER', roundIndex, questionKey, answer })
      } else {
        dispatch({ type: 'SET_FOLLOWUP_ANSWER', questionKey, answer })
      }
    },
    []
  )

  // Additional thoughts change handler - supports editing any round
  const handleAdditionalThoughtsChange = useCallback((thoughts: string, roundIndex?: number) => {
    if (roundIndex !== undefined) {
      dispatch({ type: 'SET_HISTORICAL_ADDITIONAL_THOUGHTS', roundIndex, thoughts })
    } else {
      dispatch({ type: 'SET_ADDITIONAL_THOUGHTS', thoughts })
    }
  }, [])

  // Generate follow-up questions
  const generateFollowUp = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', isLoading: true })
    dispatch({ type: 'SET_ERROR', error: null })

    try {
      // Collect previous answers
      const previousFollowups = state.followupRounds.map(round => round.answers)
      const roundNumber = state.currentFollowupRound + 1

      const response = await wizardApis.generateFollowUp(
        state.coreAnswers,
        previousFollowups.length > 0 ? previousFollowups : undefined,
        roundNumber
      )

      dispatch({
        type: 'SET_FOLLOWUP_QUESTIONS',
        questions: response.questions,
        roundNumber: response.round_number,
      })

      if (response.is_complete) {
        dispatch({ type: 'SET_FOLLOWUP_COMPLETE', isComplete: true })
      }
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: (error as Error).message })
    } finally {
      dispatch({ type: 'SET_LOADING', isLoading: false })
    }
  }, [state.coreAnswers, state.followupRounds, state.currentFollowupRound])

  // Generate prompt
  const generatePrompt = useCallback(async () => {
    if (!state.selectedShell) return

    dispatch({ type: 'SET_LOADING', isLoading: true })
    dispatch({ type: 'SET_ERROR', error: null })

    try {
      const followupAnswers = state.followupRounds.map(round => round.answers)
      const response = await wizardApis.generatePrompt(
        state.coreAnswers,
        followupAnswers.length > 0 ? followupAnswers : undefined,
        state.selectedShell.shell_type,
        state.selectedModel?.model_name
      )

      dispatch({
        type: 'SET_GENERATED_PROMPT',
        prompt: response.system_prompt,
        name: response.suggested_name,
        description: response.suggested_description,
        sampleTestMessage: response.sample_test_message || '',
      })
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: (error as Error).message })
    } finally {
      dispatch({ type: 'SET_LOADING', isLoading: false })
    }
  }, [state.coreAnswers, state.followupRounds, state.selectedShell, state.selectedModel])

  // Test prompt with a sample message using streaming
  const handleTestPrompt = useCallback(
    async (testMessage: string) => {
      dispatch({ type: 'SET_TESTING_PROMPT', isTestingPrompt: true })
      dispatch({ type: 'SET_ERROR', error: null })

      // Add empty conversation first, then update it as chunks arrive
      dispatch({
        type: 'ADD_TEST_CONVERSATION',
        conversation: {
          testMessage,
          modelResponse: '',
          userFeedback: '',
        },
      })

      let accumulatedResponse = ''

      try {
        // Use streaming API
        const stream = wizardApis.testPromptStream(
          state.systemPrompt,
          testMessage,
          state.selectedModel?.model_name,
          (chunk: string) => {
            // Update response as chunks arrive
            accumulatedResponse += chunk
            dispatch({ type: 'UPDATE_LAST_TEST_RESPONSE', response: accumulatedResponse })
          }
        )

        // Consume the stream

        for await (const _ of stream) {
          // Chunks are handled by the onChunk callback
        }
      } catch (error) {
        dispatch({ type: 'SET_ERROR', error: (error as Error).message })
      } finally {
        dispatch({ type: 'SET_TESTING_PROMPT', isTestingPrompt: false })
      }
    },
    [state.systemPrompt, state.selectedModel]
  )

  // Iterate prompt based on user feedback
  const handleIteratePrompt = useCallback(
    async (feedback: string, selectedText?: string) => {
      const lastConversation = state.testConversations[state.testConversations.length - 1]

      dispatch({ type: 'SET_ITERATING_PROMPT', isIteratingPrompt: true })
      dispatch({ type: 'SET_ERROR', error: null })

      try {
        const response = await wizardApis.iteratePrompt(
          state.systemPrompt,
          lastConversation?.testMessage || '',
          lastConversation?.modelResponse || '',
          feedback,
          state.selectedModel?.model_name,
          selectedText
        )

        // Update the prompt with the improved version
        dispatch({ type: 'SET_SYSTEM_PROMPT', prompt: response.improved_prompt })
        // Update the feedback in the last conversation (if exists)
        if (lastConversation) {
          dispatch({ type: 'UPDATE_LAST_TEST_FEEDBACK', feedback })
        }
        // Trigger prompt refreshed animation
        dispatch({ type: 'SET_PROMPT_REFRESHED', refreshed: true })
      } catch (error) {
        dispatch({ type: 'SET_ERROR', error: (error as Error).message })
      } finally {
        dispatch({ type: 'SET_ITERATING_PROMPT', isIteratingPrompt: false })
      }
    },
    [state.systemPrompt, state.testConversations, state.selectedModel]
  )

  // Clear test conversations
  const handleClearConversations = useCallback(() => {
    dispatch({ type: 'CLEAR_TEST_CONVERSATIONS' })
    // Reset the prompt refreshed flag after clearing
    dispatch({ type: 'SET_PROMPT_REFRESHED', refreshed: false })
  }, [])

  // Create all resources
  const handleCreate = useCallback(async () => {
    if (!state.selectedShell || !state.agentName) return

    // Validate bind_mode is not empty
    if (!state.bindMode || state.bindMode.length === 0) {
      dispatch({ type: 'SET_ERROR', error: t('common:team.bind_mode_required') })
      return
    }

    dispatch({ type: 'SET_LOADING', isLoading: true })
    dispatch({ type: 'SET_ERROR', error: null })

    try {
      const response = await wizardApis.createAll({
        name: state.agentName,
        description: state.agentDescription || undefined,
        system_prompt: state.systemPrompt,
        shell_name: state.selectedShell.shell_name,
        shell_type: state.selectedShell.shell_type,
        model_name: state.selectedModel?.model_name,
        model_type: 'user',
        bind_mode: state.bindMode,
        namespace: scope === 'group' && groupName ? groupName : 'default',
        icon: state.icon || undefined,
      })

      onSuccess(response.team_id, response.team_name)
      handleClose()
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: (error as Error).message })
    } finally {
      dispatch({ type: 'SET_LOADING', isLoading: false })
    }
  }, [
    state.selectedShell,
    state.selectedModel,
    state.agentName,
    state.agentDescription,
    state.systemPrompt,
    state.bindMode,
    state.icon,
    scope,
    groupName,
    onSuccess,
    handleClose,
    t,
  ])

  // Helper function to check if core answers have changed
  const hasCoreAnswersChanged = useCallback(() => {
    if (!state.lastGeneratedCoreAnswers) {
      return true // No previous snapshot, need to generate
    }
    // Compare purpose and special_requirements (the main fields)
    return (
      state.coreAnswers.purpose !== state.lastGeneratedCoreAnswers.purpose ||
      state.coreAnswers.special_requirements !== state.lastGeneratedCoreAnswers.special_requirements
    )
  }, [state.coreAnswers, state.lastGeneratedCoreAnswers])

  // Navigation handlers
  const handleNext = useCallback(async () => {
    const { currentStep } = state

    // Step 1 -> Step 2: Generate follow-up questions
    if (currentStep === 1) {
      if (!state.coreAnswers.purpose.trim()) {
        dispatch({ type: 'SET_ERROR', error: t('wizard:purpose_required') })
        return
      }

      // Check if core answers have changed since last generation
      if (hasCoreAnswersChanged()) {
        // Clear all follow-up data if answers changed
        dispatch({ type: 'CLEAR_FOLLOWUP_DATA' })
        // Save current answers as snapshot
        dispatch({ type: 'SAVE_CORE_ANSWERS_SNAPSHOT', answers: state.coreAnswers })
        dispatch({ type: 'SET_STEP', step: 2 })
        await generateFollowUp()
      } else {
        // Answers haven't changed, just go to step 2 without regenerating
        dispatch({ type: 'SET_STEP', step: 2 })
      }
      return
    }

    // Step 2: Continue follow-up or move to step 3 (Preview Adjust)
    if (currentStep === 2) {
      if (state.isFollowupComplete || state.currentFollowupRound >= 6) {
        dispatch({ type: 'SET_STEP', step: 3 })
        // Generate prompt directly (using default Chat shell)
        await generatePrompt()
      } else {
        // Continue with next round
        await generateFollowUp()
      }
      return
    }

    // Step 3 -> Step 4: Go to prompt preview and create
    if (currentStep === 3) {
      dispatch({ type: 'SET_STEP', step: 4 })
      return
    }

    // Step 4: Create
    if (currentStep === 4) {
      if (!state.agentName.trim()) {
        dispatch({ type: 'SET_ERROR', error: t('wizard:name_required') })
        return
      }
      await handleCreate()
    }
  }, [state, t, generateFollowUp, generatePrompt, handleCreate, hasCoreAnswersChanged])

  const handleBack = useCallback(() => {
    if (state.currentStep > 1) {
      // Clear test conversations when leaving step 3 (Preview Adjust)
      if (state.currentStep === 3) {
        dispatch({ type: 'CLEAR_TEST_CONVERSATIONS' })
      }
      dispatch({ type: 'SET_STEP', step: state.currentStep - 1 })
    }
  }, [state.currentStep])

  // Skip follow-up
  const handleSkipFollowUp = useCallback(async () => {
    dispatch({ type: 'SET_FOLLOWUP_COMPLETE', isComplete: true })
    dispatch({ type: 'SET_STEP', step: 3 })
    // Generate prompt directly (using default Chat shell)
    await generatePrompt()
  }, [generatePrompt])

  // Check if there are any unsaved changes in the wizard
  const hasUnsavedChanges = useCallback(() => {
    // Check if user has entered any meaningful data
    const hasCoreAnswers =
      state.coreAnswers.purpose.trim() !== '' ||
      (state.coreAnswers.special_requirements?.trim() ?? '') !== ''

    const hasFollowupData = state.followupRounds.length > 0

    const hasPromptData =
      state.systemPrompt !== '' || state.agentName !== '' || state.agentDescription !== ''

    return hasCoreAnswers || hasFollowupData || hasPromptData
  }, [
    state.coreAnswers,
    state.followupRounds,
    state.systemPrompt,
    state.agentName,
    state.agentDescription,
  ])

  // Render current step content
  const renderStepContent = () => {
    switch (state.currentStep) {
      case 1:
        return <CoreQuestionsStep answers={state.coreAnswers} onChange={handleCoreAnswersChange} />
      case 2:
        return (
          <AiFollowUpStep
            rounds={state.followupRounds}
            currentRound={state.currentFollowupRound}
            isComplete={state.isFollowupComplete}
            isLoading={state.isLoading}
            onAnswerChange={handleFollowupAnswerChange}
            onAdditionalThoughtsChange={handleAdditionalThoughtsChange}
          />
        )
      case 3:
        return (
          <PreviewAdjustStep
            systemPrompt={state.systemPrompt}
            testConversations={state.testConversations}
            isTestingPrompt={state.isTestingPrompt}
            isIteratingPrompt={state.isIteratingPrompt}
            selectedModel={state.selectedModel}
            onTestPrompt={handleTestPrompt}
            onIteratePrompt={handleIteratePrompt}
            onPromptChange={(prompt: string) => dispatch({ type: 'SET_SYSTEM_PROMPT', prompt })}
            onModelChange={(model: ModelRecommendation | null) =>
              dispatch({ type: 'SET_SELECTED_MODEL', model })
            }
            onClearConversations={handleClearConversations}
            isLoading={state.isLoading}
            promptRefreshed={state.promptRefreshed}
            sampleTestMessage={state.sampleTestMessage}
          />
        )
      case 4:
        return (
          <PromptPreviewStep
            systemPrompt={state.systemPrompt}
            agentName={state.agentName}
            agentDescription={state.agentDescription}
            onPromptChange={(prompt: string) => dispatch({ type: 'SET_SYSTEM_PROMPT', prompt })}
            onNameChange={(name: string) => dispatch({ type: 'SET_AGENT_NAME', name })}
            onDescriptionChange={(desc: string) =>
              dispatch({ type: 'SET_AGENT_DESCRIPTION', description: desc })
            }
            isLoading={false}
          />
        )
        return null
    }
  }

  // Get next button text
  const getNextButtonText = () => {
    if (state.currentStep === 2) {
      if (state.isFollowupComplete || state.currentFollowupRound >= 6) {
        return t('wizard:continue')
      }
      return t('wizard:next_question')
    }
    if (state.currentStep === 4) {
      return t('wizard:create_agent')
    }
    return t('common.next')
  }

  // Step 3 (Preview Adjust) needs full height dialog
  const isPreviewStep = state.currentStep === 3

  return (
    <Dialog open={open} onOpenChange={open => !open && handleClose()}>
      <DialogContent
        className={`max-w-5xl overflow-hidden flex flex-col ${
          isPreviewStep ? 'h-[90vh]' : 'max-h-[90vh]'
        }`}
        preventEscapeClose
        preventOutsideClick
        onBeforeClose={hasUnsavedChanges}
        onConfirmClose={handleClose}
        confirmTitle={t('wizard:confirm_close_title')}
        confirmDescription={t('wizard:confirm_close_description')}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-primary" />
            {t('wizard:title')}
          </DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex-shrink-0">
          <WizardStepIndicator currentStep={state.currentStep} totalSteps={TOTAL_STEPS} />
        </div>

        {/* Error display */}
        {state.error && (
          <div className="flex-shrink-0 p-3 bg-error/10 border border-error/20 rounded-lg flex items-center gap-2 text-error text-sm">
            <X className="w-4 h-4" />
            {state.error}
          </div>
        )}

        {/* Step content */}
        <div
          className={`flex-1 min-h-0 py-4 ${isPreviewStep ? 'overflow-hidden' : 'overflow-y-auto'}`}
        >
          {renderStepContent()}
        </div>

        {/* Footer navigation */}
        <DialogFooter className="flex-shrink-0 flex justify-between items-center">
          <div>
            {state.currentStep === 2 && !state.isFollowupComplete && (
              <Button variant="ghost" onClick={handleSkipFollowUp} disabled={state.isLoading}>
                {t('wizard:skip_questions')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {state.currentStep > 1 && (
              <Button variant="outline" onClick={handleBack} disabled={state.isLoading}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                {t('common.previous')}
              </Button>
            )}
            <Button variant="primary" onClick={handleNext} disabled={state.isLoading}>
              {state.isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {state.currentStep === 4 ? (
                <>
                  <Check className="w-4 h-4 mr-2" />
                  {getNextButtonText()}
                </>
              ) : (
                <>
                  {getNextButtonText()}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
