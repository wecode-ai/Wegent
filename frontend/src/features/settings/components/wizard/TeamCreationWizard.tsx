// SPDX-FileCopyrightText: 2025 WeCode, Inc.
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
import type { WizardAnswers } from '@/apis/wizard'

import WizardStepIndicator from './WizardStepIndicator'
import { wizardReducer, initialWizardState } from './types'
import CoreQuestionsStep from './steps/CoreQuestionsStep'
import AiFollowUpStep from './steps/AiFollowUpStep'
import RecommendationStep from './steps/RecommendationStep'
import PreviewEditStep from './steps/PreviewEditStep'
import ConfirmCreateStep from './steps/ConfirmCreateStep'

const TOTAL_STEPS = 5

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
  const { t } = useTranslation('common')
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState)

  const handleClose = useCallback(() => {
    dispatch({ type: 'RESET' })
    onClose()
  }, [onClose])

  // Core questions change handler
  const handleCoreAnswersChange = useCallback((answers: Partial<WizardAnswers>) => {
    dispatch({ type: 'SET_CORE_ANSWERS', answers })
  }, [])

  // Follow-up answer change handler
  const handleFollowupAnswerChange = useCallback((questionKey: string, answer: string) => {
    dispatch({ type: 'SET_FOLLOWUP_ANSWER', questionKey, answer })
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

  // Get recommendations
  const getRecommendations = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', isLoading: true })
    dispatch({ type: 'SET_ERROR', error: null })

    try {
      const followupAnswers = state.followupRounds.map(round => round.answers)
      const response = await wizardApis.recommendConfig(
        state.coreAnswers,
        followupAnswers.length > 0 ? followupAnswers : undefined
      )

      dispatch({
        type: 'SET_RECOMMENDATIONS',
        shell: response.shell,
        model: response.model || null,
        altShells: response.alternative_shells,
        altModels: response.alternative_models,
      })
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: (error as Error).message })
    } finally {
      dispatch({ type: 'SET_LOADING', isLoading: false })
    }
  }, [state.coreAnswers, state.followupRounds])

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
      })
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: (error as Error).message })
    } finally {
      dispatch({ type: 'SET_LOADING', isLoading: false })
    }
  }, [state.coreAnswers, state.followupRounds, state.selectedShell, state.selectedModel])

  // Create all resources
  const handleCreate = useCallback(async () => {
    if (!state.selectedShell || !state.agentName) return

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
  ])

  // Navigation handlers
  const handleNext = useCallback(async () => {
    const { currentStep } = state

    // Step 1 -> Step 2: Generate follow-up questions
    if (currentStep === 1) {
      if (!state.coreAnswers.purpose.trim()) {
        dispatch({ type: 'SET_ERROR', error: t('wizard.purpose_required') })
        return
      }
      dispatch({ type: 'SET_STEP', step: 2 })
      await generateFollowUp()
      return
    }

    // Step 2: Continue follow-up or move to step 3
    if (currentStep === 2) {
      if (state.isFollowupComplete || state.currentFollowupRound >= 6) {
        dispatch({ type: 'SET_STEP', step: 3 })
        await getRecommendations()
      } else {
        // Continue with next round
        await generateFollowUp()
      }
      return
    }

    // Step 3 -> Step 4: Generate prompt
    if (currentStep === 3) {
      dispatch({ type: 'SET_STEP', step: 4 })
      await generatePrompt()
      return
    }

    // Step 4 -> Step 5
    if (currentStep === 4) {
      if (!state.agentName.trim()) {
        dispatch({ type: 'SET_ERROR', error: t('wizard.name_required') })
        return
      }
      dispatch({ type: 'SET_STEP', step: 5 })
      return
    }

    // Step 5: Create
    if (currentStep === 5) {
      await handleCreate()
    }
  }, [
    state,
    t,
    generateFollowUp,
    getRecommendations,
    generatePrompt,
    handleCreate,
  ])

  const handleBack = useCallback(() => {
    if (state.currentStep > 1) {
      dispatch({ type: 'SET_STEP', step: state.currentStep - 1 })
    }
  }, [state.currentStep])

  // Skip follow-up
  const handleSkipFollowUp = useCallback(async () => {
    dispatch({ type: 'SET_FOLLOWUP_COMPLETE', isComplete: true })
    dispatch({ type: 'SET_STEP', step: 3 })
    await getRecommendations()
  }, [getRecommendations])

  // Render current step content
  const renderStepContent = () => {
    switch (state.currentStep) {
      case 1:
        return (
          <CoreQuestionsStep
            answers={state.coreAnswers}
            onChange={handleCoreAnswersChange}
          />
        )
      case 2:
        return (
          <AiFollowUpStep
            rounds={state.followupRounds}
            currentRound={state.currentFollowupRound}
            isComplete={state.isFollowupComplete}
            isLoading={state.isLoading}
            onAnswerChange={handleFollowupAnswerChange}
          />
        )
      case 3:
        return (
          <RecommendationStep
            shell={state.shellRecommendation}
            model={state.modelRecommendation}
            alternativeShells={state.alternativeShells}
            alternativeModels={state.alternativeModels}
            selectedShell={state.selectedShell}
            selectedModel={state.selectedModel}
            onSelectShell={shell => dispatch({ type: 'SET_SELECTED_SHELL', shell })}
            onSelectModel={model => dispatch({ type: 'SET_SELECTED_MODEL', model })}
            isLoading={state.isLoading}
          />
        )
      case 4:
        return (
          <PreviewEditStep
            systemPrompt={state.systemPrompt}
            agentName={state.agentName}
            agentDescription={state.agentDescription}
            bindMode={state.bindMode}
            onPromptChange={prompt => dispatch({ type: 'SET_SYSTEM_PROMPT', prompt })}
            onNameChange={name => dispatch({ type: 'SET_AGENT_NAME', name })}
            onDescriptionChange={desc => dispatch({ type: 'SET_AGENT_DESCRIPTION', description: desc })}
            onBindModeChange={mode => dispatch({ type: 'SET_BIND_MODE', mode })}
            isLoading={state.isLoading}
          />
        )
      case 5:
        return (
          <ConfirmCreateStep
            agentName={state.agentName}
            agentDescription={state.agentDescription}
            systemPrompt={state.systemPrompt}
            selectedShell={state.selectedShell}
            selectedModel={state.selectedModel}
            bindMode={state.bindMode}
          />
        )
      default:
        return null
    }
  }

  // Get next button text
  const getNextButtonText = () => {
    if (state.currentStep === 2) {
      if (state.isFollowupComplete || state.currentFollowupRound >= 6) {
        return t('wizard.continue')
      }
      return t('wizard.next_question')
    }
    if (state.currentStep === 5) {
      return t('wizard.create_agent')
    }
    return t('common.next')
  }

  return (
    <Dialog open={open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-primary" />
            {t('wizard.title')}
          </DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <WizardStepIndicator currentStep={state.currentStep} totalSteps={TOTAL_STEPS} />

        {/* Error display */}
        {state.error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded-lg flex items-center gap-2 text-error text-sm">
            <X className="w-4 h-4" />
            {state.error}
          </div>
        )}

        {/* Step content */}
        <div className="flex-1 overflow-y-auto py-4">{renderStepContent()}</div>

        {/* Footer navigation */}
        <DialogFooter className="flex-shrink-0 flex justify-between items-center">
          <div>
            {state.currentStep === 2 && !state.isFollowupComplete && (
              <Button
                variant="ghost"
                onClick={handleSkipFollowUp}
                disabled={state.isLoading}
              >
                {t('wizard.skip_questions')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {state.currentStep > 1 && (
              <Button variant="outline" onClick={handleBack} disabled={state.isLoading}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                {t('common.back')}
              </Button>
            )}
            <Button variant="primary" onClick={handleNext} disabled={state.isLoading}>
              {state.isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {state.currentStep === 5 ? (
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
