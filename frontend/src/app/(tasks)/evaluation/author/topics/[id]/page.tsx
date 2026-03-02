// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  Plus,
  Users,
  FileCheck,
  BarChart3,
  Send,
  History,
  Bot,
  Settings,
  GraduationCap,
  GripVertical,
  Pencil,
  Trash2,
  FileText,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import {
  getAuthorTopic,
  publishAuthorTopic,
  getAuthorTopicStatistics,
  listAuthorQuestions,
  reorderAuthorQuestions,
  deleteAuthorQuestion,
  publishAuthorQuestion,
} from '@wecode/api/evaluation-author'
import type { Topic, Question, TopicStatistics } from '@wecode/types/evaluation'
import { TopicStatus, TopicVisibility, QuestionStatus, ContentType } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
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

// Sortable question card component
interface SortableQuestionCardProps {
  question: Question
  index: number
  onEdit: (questionId: number) => void
  onDelete: (question: Question) => void
  onPublish: (questionId: number) => void
  getStatusText: (status: number, type: 'topic' | 'question') => string
  t: (key: string) => string
}

function SortableQuestionCard({
  question,
  index,
  onEdit,
  onDelete,
  onPublish,
  getStatusText,
  t,
}: SortableQuestionCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: question.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 1,
  }

  // Get content preview from question content_data
  const getContentPreview = (): string => {
    const contentData = question.content_data as Record<string, unknown> | undefined
    if (!contentData) return ''

    // Try to get text content
    const text = contentData.text as string | undefined
    if (text) {
      return text.length > 100 ? text.substring(0, 100) + '...' : text
    }

    // For rich_exam content type
    if (question.content_type === ContentType.MIXED) {
      const context = contentData.context as string | undefined
      if (context) {
        return context.length > 100 ? context.substring(0, 100) + '...' : context
      }
    }

    return ''
  }

  const isPublished = question.status === QuestionStatus.PUBLISHED

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative ${isDragging ? 'opacity-50' : ''}`}
    >
      <Card className="transition-shadow hover:shadow-md">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Drag handle */}
            <button
              {...attributes}
              {...listeners}
              className="mt-1 cursor-grab active:cursor-grabbing text-text-muted hover:text-text-secondary"
            >
              <GripVertical className="h-5 w-5" />
            </button>

            {/* Question number */}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface text-sm font-medium">
              {index + 1}
            </span>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-medium">{question.title}</h3>
                  <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
                    {getContentPreview() || (
                      <span className="italic text-text-muted">{t('questions.no_content')}</span>
                    )}
                  </p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
                    <span>{t(`questions.content_types.${question.content_type}`)}</span>
                    {question.criteria_type && (
                      <>
                        <span>•</span>
                        <span>{t('questions.criteria')}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={isPublished ? 'success' : 'info'}>
                    {getStatusText(question.status, 'question')}
                  </Badge>
                </div>
              </div>

              {/* Quick actions */}
              <div className="mt-3 flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => onEdit(question.id)}>
                  <Pencil className="mr-1 h-4 w-4" />
                  {t('actions.edit')}
                </Button>
                {!isPublished && (
                  <Button variant="ghost" size="sm" onClick={() => onPublish(question.id)}>
                    <Send className="mr-1 h-4 w-4" />
                    {t('questions.publish')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onDelete(question)}
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  {t('actions.delete')}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function TopicDetailContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [statistics, setStatistics] = useState<TopicStatistics | null>(null)
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [questionToDelete, setQuestionToDelete] = useState<Question | null>(null)
  const [deletingQuestionId, setDeletingQuestionId] = useState<number | null>(null)

  // Sensors for drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, questionsData, statsData] = await Promise.all([
        getAuthorTopic(topicId),
        listAuthorQuestions(topicId, { limit: 100 }),
        getAuthorTopicStatistics(topicId),
      ])
      setTopic(topicData)
      setQuestions(questionsData.items)
      setStatistics(statsData)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/author')
    } finally {
      setLoading(false)
    }
  }, [topicId, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

  const handlePublish = async () => {
    setPublishing(true)
    try {
      await publishAuthorTopic(topicId)
      toast({
        title: t('topics.published_success'),
        description: '',
      })
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      setReordering(true)
      const oldIndex = questions.findIndex(q => q.id === active.id)
      const newIndex = questions.findIndex(q => q.id === over.id)

      // Optimistically update UI
      const newQuestions = arrayMove(questions, oldIndex, newIndex)
      setQuestions(newQuestions)

      // Call API to persist reorder
      try {
        await reorderAuthorQuestions(
          topicId,
          newQuestions.map(q => q.id)
        )
      } catch (_error) {
        // Revert on error
        setQuestions(questions)
        toast({
          title: t('errors.save_failed'),
          description: 'Failed to reorder questions',
          variant: 'destructive',
        })
      } finally {
        setReordering(false)
      }
    }
  }

  const handleEditQuestion = (questionId: number) => {
    router.push(`/evaluation/author/topics/${topicId}/questions/${questionId}`)
  }

  const handleDeleteClick = (question: Question) => {
    setQuestionToDelete(question)
    setDeleteDialogOpen(true)
  }

  const handleConfirmDelete = async () => {
    if (!questionToDelete) return

    setDeletingQuestionId(questionToDelete.id)
    try {
      await deleteAuthorQuestion(questionToDelete.id)
      toast({
        title: t('questions.deleted_success'),
        description: '',
      })
      // Remove from local state
      setQuestions(questions.filter(q => q.id !== questionToDelete.id))
    } catch (_error) {
      toast({
        title: t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setDeletingQuestionId(null)
      setDeleteDialogOpen(false)
      setQuestionToDelete(null)
    }
  }

  const handlePublishQuestion = async (questionId: number) => {
    try {
      await publishAuthorQuestion(questionId)
      toast({
        title: t('questions.published_success'),
        description: '',
      })
      // Update local state
      setQuestions(
        questions.map(q => (q.id === questionId ? { ...q, status: QuestionStatus.PUBLISHED } : q))
      )
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }

  // Helper function to get visibility label with i18n
  const getVisibilityText = (visibility: string) => {
    if (visibility === TopicVisibility.PUBLIC) {
      return t('topics.public')
    }
    return t('topics.private')
  }

  // Helper function to get status label with i18n
  const getStatusText = (status: number, type: 'topic' | 'question') => {
    if (type === 'topic' || type === 'question') {
      if (status === TopicStatus.DRAFT) {
        return t('common.draft')
      }
      return t('topics.published')
    }
    return ''
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="mb-4 h-8 w-1/2" />
        <Skeleton className="mb-8 h-4 w-3/4" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    )
  }

  if (!topic) {
    return null
  }

  const publishedQuestions = questions.filter(q => q.status === QuestionStatus.PUBLISHED)
  const isExamMode = topic.extra_data?.examMode === true

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push('/evaluation/author')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/evaluation/author/topics/${topicId}/config`)}
          >
            <Settings className="mr-2 h-4 w-4" />
            {t('actions.config', 'Configuration')}
          </Button>
        </div>
      </div>

      {/* Topic Info */}
      <div className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-text-primary">{topic.name}</h1>
          <Badge variant={topic.visibility === TopicVisibility.PUBLIC ? 'default' : 'secondary'}>
            {getVisibilityText(topic.visibility)}
          </Badge>
          <Badge variant={topic.status === TopicStatus.PUBLISHED ? 'success' : 'info'}>
            {getStatusText(topic.status, 'topic')}
          </Badge>
          {isExamMode && (
            <Badge variant="warning">
              <GraduationCap className="mr-1 h-3 w-3" />
              {t('topics.exam_mode', 'Exam Mode')}
            </Badge>
          )}
        </div>
        {topic.description && <p className="mb-4 text-text-secondary">{topic.description}</p>}

        {/* Publish Button - show only when there are published questions */}
        {publishedQuestions.length > 0 ? (
          <Button variant="primary" onClick={handlePublish} disabled={publishing}>
            <Send className="mr-2 h-4 w-4" />
            {publishing ? '...' : t('topics.publish')}
          </Button>
        ) : questions.length > 0 ? (
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-sm text-text-muted">{t('topics.publish_hint')}</p>
          </div>
        ) : null}
      </div>

      {/* Statistics */}
      {statistics && (
        <div className="mb-8 grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">{t('questions.title')}</div>
              <div className="text-2xl font-semibold">
                {statistics.published_questions} / {statistics.total_questions}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">{t('answers.respondents')}</div>
              <div className="text-2xl font-semibold">{statistics.total_respondents}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">{t('answers.title')}</div>
              <div className="text-2xl font-semibold">{statistics.total_answers}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">{t('grading.title')}</div>
              <div className="text-2xl font-semibold">
                {statistics.grading_published} / {statistics.grading_completed}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="questions">
        <TabsList>
          <TabsTrigger value="questions">
            <FileCheck className="mr-2 h-4 w-4" />
            {t('questions.title')} ({questions.length})
          </TabsTrigger>
          <TabsTrigger value="permissions">
            <Users className="mr-2 h-4 w-4" />
            {t('permissions.title')}
          </TabsTrigger>
          <TabsTrigger value="grading">
            <BarChart3 className="mr-2 h-4 w-4" />
            {t('grading.title')}
          </TabsTrigger>
          <TabsTrigger value="versions">
            <History className="mr-2 h-4 w-4" />
            {t('topics.versions')}
          </TabsTrigger>
          {isExamMode && (
            <TabsTrigger value="exam-sessions">
              <GraduationCap className="mr-2 h-4 w-4" />
              考试会话
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="questions" className="mt-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium">{t('questions.title')}</h2>
              {questions.length > 0 && (
                <p className="text-sm text-text-muted">Drag and drop to reorder questions</p>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => router.push(`/evaluation/author/topics/${topicId}/questions/new`)}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('questions.add')}
            </Button>
          </div>

          {questions.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <FileText className="mx-auto mb-4 h-12 w-12 text-text-muted" />
                <p className="text-text-secondary">{t('questions.no_questions')}</p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => router.push(`/evaluation/author/topics/${topicId}/questions/new`)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {t('questions.create_first')}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={questions.map(q => q.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className={`space-y-3 ${reordering ? 'pointer-events-none opacity-70' : ''}`}>
                  {questions.map((question, index) => (
                    <SortableQuestionCard
                      key={question.id}
                      question={question}
                      index={index}
                      onEdit={handleEditQuestion}
                      onDelete={handleDeleteClick}
                      onPublish={handlePublishQuestion}
                      getStatusText={getStatusText}
                      t={t}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </TabsContent>

        <TabsContent value="permissions" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('permissions.management')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">{t('permissions.description')}</p>
              <Button
                variant="primary"
                onClick={() => router.push(`/evaluation/author/topics/${topicId}/permissions`)}
              >
                <Users className="mr-2 h-4 w-4" />
                {t('permissions.manage')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="grading" className="mt-6">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Grading Configuration Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5" />
                  {t('grading.config_title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-text-secondary">
                  {t('grading.select_team_description')}
                </p>
                <Button
                  variant="outline"
                  onClick={() => router.push(`/evaluation/author/topics/${topicId}/grading-config`)}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  {t('grading.config_title')}
                </Button>
              </CardContent>
            </Card>

            {/* Grading Tasks Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  {t('grading.tasks')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-text-secondary">{t('grading.description')}</p>
                <Button
                  variant="primary"
                  onClick={() => router.push(`/evaluation/grader/topics/${topicId}`)}
                >
                  {t('grading.view_tasks')}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="versions" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('topics.version_history')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">{t('topics.version_description')}</p>
              <Button
                variant="primary"
                onClick={() => router.push(`/evaluation/author/topics/${topicId}/versions`)}
              >
                <History className="mr-2 h-4 w-4" />
                {t('topics.view_versions')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {isExamMode && (
          <TabsContent value="exam-sessions" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GraduationCap className="h-5 w-5" />
                  考试会话管理
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-text-secondary">
                  查看和管理考生的考试会话状态，包括考试进度、剩余时间和提交次数。
                </p>
                <Button
                  variant="primary"
                  onClick={() => router.push(`/evaluation/author/topics/${topicId}/exam-sessions`)}
                >
                  <GraduationCap className="mr-2 h-4 w-4" />
                  管理考试会话
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              {t('questions.delete_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('questions.delete_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingQuestionId !== null}>
              {t('actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deletingQuestionId !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingQuestionId !== null ? '...' : t('actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default function TopicDetailPage() {
  return (
    <EvaluationPageLayout>
      <TopicDetailContent />
    </EvaluationPageLayout>
  )
}
