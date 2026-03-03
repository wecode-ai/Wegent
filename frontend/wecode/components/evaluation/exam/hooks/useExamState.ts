import { useState, useCallback } from 'react'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

export interface QuestionState {
  supplementaryNotes: string
  mainFiles: ExamAttachment[]
  interactionFiles: ExamAttachment[]
  bonusAgentLink: string
  bonusAgentFiles: ExamAttachment[]
  bonusMultimodalFiles: ExamAttachment[]
}

export interface ExamState {
  participantName: string
  selectedQuestionId: number | null
  questionStates: Record<number, QuestionState>
}

const createInitialQuestionState = (): QuestionState => ({
  supplementaryNotes: '',
  mainFiles: [],
  interactionFiles: [],
  bonusAgentLink: '',
  bonusAgentFiles: [],
  bonusMultimodalFiles: [],
})

const initialState: ExamState = {
  participantName: '',
  selectedQuestionId: null,
  questionStates: {},
}

/**
 * Hook for managing exam form state with multi-question support.
 *
 * Provides state management for exam submission including:
 * - Participant information
 * - Question selection
 * - Per-question file attachments (main, interaction, bonus)
 * - Per-question bonus agent link
 * - Per-question supplementary notes
 *
 * @returns Exam state and state update functions
 */
export function useExamState() {
  const [state, setState] = useState<ExamState>(initialState)

  // Get current question's state
  const currentQuestionState = state.selectedQuestionId
    ? (state.questionStates[state.selectedQuestionId] ?? createInitialQuestionState())
    : createInitialQuestionState()

  /**
   * Update state for a specific question.
   * @param questionId - Question ID
   * @param updates - Partial state updates
   */
  const updateQuestionState = useCallback((questionId: number, updates: Partial<QuestionState>) => {
    setState(prev => ({
      ...prev,
      questionStates: {
        ...prev.questionStates,
        [questionId]: {
          ...(prev.questionStates[questionId] ?? createInitialQuestionState()),
          ...updates,
        },
      },
    }))
  }, [])

  /**
   * Set the participant name.
   * @param name - Participant name
   */
  const setParticipantName = useCallback((name: string) => {
    setState(prev => ({ ...prev, participantName: name }))
  }, [])

  /**
   * Set the selected question ID.
   * @param id - Question ID or null to clear selection
   */
  const setSelectedQuestionId = useCallback((id: number | null) => {
    setState(prev => ({ ...prev, selectedQuestionId: id }))
  }, [])

  /**
   * Set supplementary notes for current question.
   * @param notes - Additional notes from participant
   */
  const setSupplementaryNotes = useCallback(
    (notes: string) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      updateQuestionState(questionId, { supplementaryNotes: notes })
    },
    [state.selectedQuestionId, updateQuestionState]
  )

  /**
   * Add main deliverable files for current question.
   * @param files - Array of file attachments to add
   */
  const addMainFiles = useCallback(
    (files: ExamAttachment[]) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, { mainFiles: [...current.mainFiles, ...files] })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Remove a main file by index for current question.
   * @param index - Index of file to remove
   */
  const removeMainFile = useCallback(
    (index: number) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, {
        mainFiles: current.mainFiles.filter((_, i) => i !== index),
      })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Add interaction design files for current question.
   * @param files - Array of file attachments to add
   */
  const addInteractionFiles = useCallback(
    (files: ExamAttachment[]) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, { interactionFiles: [...current.interactionFiles, ...files] })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Remove an interaction file by index for current question.
   * @param index - Index of file to remove
   */
  const removeInteractionFile = useCallback(
    (index: number) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, {
        interactionFiles: current.interactionFiles.filter((_, i) => i !== index),
      })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Set the bonus agent deployment link for current question.
   * @param link - Deployment URL
   */
  const setBonusAgentLink = useCallback(
    (link: string) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      updateQuestionState(questionId, { bonusAgentLink: link })
    },
    [state.selectedQuestionId, updateQuestionState]
  )

  /**
   * Add bonus agent files for current question.
   * @param files - Array of file attachments to add
   */
  const addBonusAgentFiles = useCallback(
    (files: ExamAttachment[]) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, { bonusAgentFiles: [...current.bonusAgentFiles, ...files] })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Remove a bonus agent file by index for current question.
   * @param index - Index of file to remove
   */
  const removeBonusAgentFile = useCallback(
    (index: number) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, {
        bonusAgentFiles: current.bonusAgentFiles.filter((_, i) => i !== index),
      })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Add bonus multimodal files for current question.
   * @param files - Array of file attachments to add
   */
  const addBonusMultimodalFiles = useCallback(
    (files: ExamAttachment[]) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, {
        bonusMultimodalFiles: [...current.bonusMultimodalFiles, ...files],
      })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Remove a bonus multimodal file by index for current question.
   * @param index - Index of file to remove
   */
  const removeBonusMultimodalFile = useCallback(
    (index: number) => {
      const questionId = state.selectedQuestionId
      if (questionId === null) return
      const current = state.questionStates[questionId] ?? createInitialQuestionState()
      updateQuestionState(questionId, {
        bonusMultimodalFiles: current.bonusMultimodalFiles.filter((_, i) => i !== index),
      })
    },
    [state.selectedQuestionId, state.questionStates, updateQuestionState]
  )

  /**
   * Check if the exam is ready to submit.
   * Requires: participant name, selected question, and at least one main file.
   */
  const isSubmitReady =
    state.participantName.trim().length > 0 &&
    state.selectedQuestionId !== null &&
    currentQuestionState.mainFiles.length > 0

  return {
    state: {
      ...state,
      ...currentQuestionState,
    },
    setParticipantName,
    setSelectedQuestionId,
    setSupplementaryNotes,
    addMainFiles,
    removeMainFile,
    addInteractionFiles,
    removeInteractionFile,
    setBonusAgentLink,
    addBonusAgentFiles,
    removeBonusAgentFile,
    addBonusMultimodalFiles,
    removeBonusMultimodalFile,
    isSubmitReady,
    questionStates: state.questionStates,
    currentQuestionState,
  }
}
