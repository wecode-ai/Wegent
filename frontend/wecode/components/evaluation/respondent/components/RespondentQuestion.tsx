'use client'

import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useAnswerTimer } from '../hooks/useAnswerTimer'
import { useRespondentQuestion } from '../hooks/useRespondentQuestion'
import { QuestionHeader, QuestionPanel, AnswerPanel } from './sub-components'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { Topic } from '@wecode/types/evaluation'

interface RespondentQuestionProps {
  topic: Topic
  questionId: number
  currentQuestionIndex: number
  totalQuestions: number
  questionIds: number[]
}

export function RespondentQuestion({
  topic,
  questionId,
  currentQuestionIndex,
  totalQuestions,
  questionIds,
}: RespondentQuestionProps) {
  const isMobile = useIsMobile()
  const { t } = useTranslation('evaluation')
  const { formattedTime } = useAnswerTimer()

  const {
    question,
    loading,
    answerText,
    attachments,
    lastSubmittedAnswer,
    submitting,
    showConfirmDialog,
    showTextInput,
    showLastSubmitted,
    showInstructions,
    progress,
    instructions,
    lastSaved,
    isEmpty,
    setAnswerText,
    setAttachments,
    setShowTextInput,
    setShowLastSubmitted,
    setShowInstructions,
    setShowConfirmDialog,
    handlePrevious,
    handleNext,
    handleSubmitClick,
    handleSubmit,
  } = useRespondentQuestion({
    topic,
    questionId,
    currentQuestionIndex,
    totalQuestions,
    questionIds,
  })

  // Loading state
  if (loading || !question) {
    return (
      <div className={`flex h-screen flex-col ${isMobile ? '' : 'bg-surface'}`}>
        <div
          className={`${isMobile ? 'h-14' : 'h-16'} border-b border-border ${isMobile ? 'bg-surface' : 'bg-white'}`}
        />
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    )
  }

  return (
    <div className={`flex h-screen flex-col ${isMobile ? 'bg-base' : 'bg-surface'}`}>
      {/* Header */}
      <QuestionHeader
        topicName={topic.name}
        progress={progress}
        formattedTime={formattedTime}
        currentIndex={currentQuestionIndex}
        totalQuestions={totalQuestions}
        onPrevious={handlePrevious}
        onNext={handleNext}
        isFirst={currentQuestionIndex === 0}
        isLast={currentQuestionIndex === totalQuestions - 1}
      />

      {/* Main Content */}
      {isMobile ? (
        // Mobile: Single column scrollable
        <div className="flex-1 overflow-y-auto">
          <QuestionPanel
            question={question}
            instructions={instructions}
            showInstructions={showInstructions}
            onToggleInstructions={() => setShowInstructions(!showInstructions)}
          />
          <AnswerPanel
            answerText={answerText}
            attachments={attachments}
            showTextInput={showTextInput}
            onTextChange={setAnswerText}
            onAttachmentsChange={setAttachments}
            onToggleTextInput={() => setShowTextInput(!showTextInput)}
            lastSubmittedAnswer={lastSubmittedAnswer}
            showLastSubmitted={showLastSubmitted}
            onToggleLastSubmitted={() => setShowLastSubmitted(!showLastSubmitted)}
            isSubmitting={submitting}
            isEmpty={isEmpty}
            lastSaved={lastSaved}
            onSubmitClick={handleSubmitClick}
            topicId={topic.id}
            questionId={questionId}
            isResubmit={!!lastSubmittedAnswer}
          />
        </div>
      ) : (
        // Desktop: Two-column grid
        <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
          <QuestionPanel
            question={question}
            instructions={instructions}
            showInstructions={showInstructions}
            onToggleInstructions={() => setShowInstructions(!showInstructions)}
          />
          <AnswerPanel
            answerText={answerText}
            attachments={attachments}
            showTextInput={showTextInput}
            onTextChange={setAnswerText}
            onAttachmentsChange={setAttachments}
            onToggleTextInput={() => setShowTextInput(!showTextInput)}
            lastSubmittedAnswer={lastSubmittedAnswer}
            showLastSubmitted={showLastSubmitted}
            onToggleLastSubmitted={() => setShowLastSubmitted(!showLastSubmitted)}
            isSubmitting={submitting}
            isEmpty={isEmpty}
            lastSaved={lastSaved}
            onSubmitClick={handleSubmitClick}
            topicId={topic.id}
            questionId={questionId}
            isResubmit={!!lastSubmittedAnswer}
          />
        </div>
      )}

      {/* Confirm Dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('answers.confirm_submit_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('answers.confirm_submit_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmit}>{t('common:actions.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
