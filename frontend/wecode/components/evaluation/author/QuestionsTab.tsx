// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Plus, FileQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { Question } from '@wecode/types/evaluation'
import {
  reorderAuthorQuestions,
  publishAuthorQuestion,
  deleteAuthorQuestion,
} from '@wecode/api/evaluation-author'
import { QuestionCard } from './QuestionCard'
import { QuestionEditorDrawer } from './QuestionEditorDrawer'

/**
 * Props for the QuestionsTab component
 */
interface QuestionsTabProps {
  /** Topic ID */
  topicId: number
  /** Array of questions to display */
  questions: Question[]
  /** Whether the data is loading */
  isLoading?: boolean
  /** Callback when questions are reordered */
  onQuestionsChange: (questions: Question[]) => void
}

/**
 * Empty state component when no questions exist
 */
function EmptyState({ onAddQuestion }: { onAddQuestion: () => void }) {
  const { t } = useTranslation('evaluation')

  const handleClick = () => {
    onAddQuestion()
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 border-dashed p-12 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-4">
        <FileQuestion className="w-8 h-8 text-gray-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{t('questions.no_questions')}</h3>
      <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
        Get started by creating your first question for this topic.
      </p>
      <Button onClick={handleClick} className="bg-[#DF2029] hover:bg-[#c81d25] text-white">
        <Plus className="w-4 h-4 mr-2" />
        {t('questions.create_first')}
      </Button>
    </div>
  )
}

/**
 * Loading skeleton for questions list
 */
function QuestionsListSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-start gap-4">
            <Skeleton className="w-8 h-8 rounded-lg shrink-0" />
            <Skeleton className="w-8 h-8 rounded-lg shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-5 w-24" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-3 w-32" />
            </div>
            <div className="flex items-center gap-1">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-8 w-8 rounded-lg" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * QuestionsTab - Tab content for managing questions
 *
 * Features:
 * - Drag-and-drop reorderable question list using @dnd-kit
 * - Add Question button with red accent (#DF2029)
 * - Empty state when no questions
 * - Loading skeleton state
 * - Edit, Publish/Unpublish, Delete actions for each question
 *
 * Design:
 * - Clean white cards with consistent spacing
 * - Smooth drag animations
 * - Visual feedback during interactions
 */
export function QuestionsTab({
  topicId,
  questions,
  isLoading = false,
  onQuestionsChange,
}: QuestionsTabProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const [isReordering, setIsReordering] = useState(false)
  const [processingIds, setProcessingIds] = useState<Set<number>>(new Set())

  // Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [editingQuestionId, setEditingQuestionId] = useState<number | undefined>(undefined)

  // Configure sensors for drag-and-drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Handle drag end - reorder questions
  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event

      if (!over || active.id === over.id) {
        return
      }

      const oldIndex = questions.findIndex(q => q.id === active.id)
      const newIndex = questions.findIndex(q => q.id === over.id)

      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      // Optimistically update UI
      const newQuestions = arrayMove(questions, oldIndex, newIndex)
      onQuestionsChange(newQuestions)

      // Send reorder request to server
      setIsReordering(true)
      try {
        const questionIds = newQuestions.map(q => q.id)
        await reorderAuthorQuestions(topicId, questionIds)
        toast({
          title: 'Order updated',
          description: 'Questions have been reordered successfully.',
        })
      } catch (_error) {
        // Revert on error
        onQuestionsChange(questions)
        toast({
          title: 'Failed to reorder',
          description: 'Could not update question order. Please try again.',
          variant: 'destructive',
        })
      } finally {
        setIsReordering(false)
      }
    },
    [questions, topicId, onQuestionsChange, toast]
  )

  // Handle edit question - open drawer instead of navigating
  const handleEdit = useCallback((questionId: number) => {
    setEditingQuestionId(questionId)
    setIsDrawerOpen(true)
  }, [])

  // Handle add question - open drawer in create mode
  const handleAddQuestion = useCallback(() => {
    setEditingQuestionId(undefined)
    setIsDrawerOpen(true)
  }, [])

  // Handle drawer close
  const handleDrawerClose = useCallback(() => {
    setIsDrawerOpen(false)
    setEditingQuestionId(undefined)
  }, [])

  // Handle question change (create/update)
  const handleQuestionChange = useCallback(
    (updatedQuestion: Question) => {
      if (editingQuestionId) {
        // Update existing question in list
        const updatedQuestions = questions.map(q =>
          q.id === updatedQuestion.id ? updatedQuestion : q
        )
        onQuestionsChange(updatedQuestions)
      } else {
        // Add new question to list
        onQuestionsChange([...questions, updatedQuestion])
      }
    },
    [editingQuestionId, questions, onQuestionsChange]
  )

  // Handle publish/unpublish toggle
  const handlePublishToggle = useCallback(
    async (questionId: number, isPublished: boolean) => {
      setProcessingIds(prev => new Set(prev).add(questionId))
      try {
        await publishAuthorQuestion(questionId)
        // Update local state
        const updatedQuestions = questions.map(q =>
          q.id === questionId ? { ...q, status: isPublished ? 0 : 1 } : q
        )
        onQuestionsChange(updatedQuestions)
        toast({
          title: isPublished ? 'Unpublished' : 'Published',
          description: `Question has been ${isPublished ? 'unpublished' : 'published'} successfully.`,
        })
      } catch (_error) {
        toast({
          title: 'Action failed',
          description: `Could not ${isPublished ? 'unpublish' : 'publish'} question. Please try again.`,
          variant: 'destructive',
        })
      } finally {
        setProcessingIds(prev => {
          const next = new Set(prev)
          next.delete(questionId)
          return next
        })
      }
    },
    [questions, onQuestionsChange, toast]
  )

  // Handle delete question
  const handleDelete = useCallback(
    async (questionId: number) => {
      setProcessingIds(prev => new Set(prev).add(questionId))
      try {
        await deleteAuthorQuestion(questionId)
        // Update local state
        const updatedQuestions = questions.filter(q => q.id !== questionId)
        onQuestionsChange(updatedQuestions)
        toast({
          title: 'Deleted',
          description: 'Question has been deleted successfully.',
        })
      } catch (_error) {
        toast({
          title: 'Delete failed',
          description: 'Could not delete question. Please try again.',
          variant: 'destructive',
        })
      } finally {
        setProcessingIds(prev => {
          const next = new Set(prev)
          next.delete(questionId)
          return next
        })
      }
    },
    [questions, onQuestionsChange, toast]
  )

  return (
    <>
      {isLoading ? (
        // Loading skeleton
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-10 w-32" />
          </div>
          <QuestionsListSkeleton />
        </div>
      ) : questions.length === 0 ? (
        // Empty state
        <EmptyState onAddQuestion={handleAddQuestion} />
      ) : (
        // Normal list with questions
        <div className="space-y-6">
          {/* Header with add button */}
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-500">
              {questions.length} {questions.length === 1 ? 'question' : 'questions'}
            </div>
            <Button
              onClick={handleAddQuestion}
              className="bg-[#DF2029] hover:bg-[#c81d25] text-white"
            >
              <Plus className="w-4 h-4 mr-2" />
              {t('questions.add')}
            </Button>
          </div>

          {/* Draggable questions list */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={questions.map(q => q.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-4">
                {questions.map((question, index) => (
                  <QuestionCard
                    key={question.id}
                    question={question}
                    displayIndex={index + 1}
                    onEdit={handleEdit}
                    onPublishToggle={handlePublishToggle}
                    onDelete={handleDelete}
                    disabled={isReordering || processingIds.has(question.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {/* Drag hint */}
          <p className="text-xs text-gray-400 text-center">
            Drag and drop questions to reorder them
          </p>
        </div>
      )}

      {/* Question Editor Drawer - always rendered outside conditional content */}
      <QuestionEditorDrawer
        isOpen={isDrawerOpen}
        topicId={topicId}
        questionId={editingQuestionId}
        onClose={handleDrawerClose}
        onQuestionChange={handleQuestionChange}
      />
    </>
  )
}
