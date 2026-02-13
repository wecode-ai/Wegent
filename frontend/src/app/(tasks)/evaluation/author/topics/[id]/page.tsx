// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  Trash2,
  Plus,
  Users,
  FileCheck,
  BarChart3,
  Send,
  Edit,
  History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import {
  getAuthorTopic,
  deleteAuthorTopic,
  publishAuthorTopic,
  getAuthorTopicStatistics,
  listAuthorQuestions,
} from '@wecode/api/evaluation-author'
import type { Topic, Question, TopicStatistics } from '@wecode/types/evaluation'
import {
  TopicStatus,
  TopicVisibility,
  QuestionStatus,
  getStatusLabel,
  getVisibilityLabel,
} from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

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
  const [deleting, setDeleting] = useState(false)

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
        title: t('topics.published_success', 'Topic published successfully'),
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

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteAuthorTopic(topicId)
      toast({
        title: t('topics.deleted_success', 'Topic deleted successfully'),
        description: '',
      })
      router.push('/evaluation/author')
    } catch (_error) {
      toast({
        title: t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
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

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push('/evaluation/author')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back', 'Back to Topics')}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/evaluation/author/topics/${topicId}/edit`)}
          >
            <Edit className="mr-2 h-4 w-4" />
            {t('actions.edit', 'Edit')}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="text-destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                {t('actions.delete', 'Delete')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('topics.delete_title', 'Delete Topic')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    'topics.delete_description',
                    'Are you sure you want to delete this topic? This action cannot be undone.'
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('actions.cancel', 'Cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  disabled={deleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleting ? '...' : t('actions.delete', 'Delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Topic Info */}
      <div className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-text-primary">{topic.name}</h1>
          <Badge variant={topic.visibility === TopicVisibility.PUBLIC ? 'default' : 'secondary'}>
            {getVisibilityLabel(topic.visibility)}
          </Badge>
          <Badge variant={topic.status === TopicStatus.PUBLISHED ? 'success' : 'info'}>
            {getStatusLabel(topic.status, 'topic')}
          </Badge>
        </div>
        {topic.description && <p className="mb-4 text-text-secondary">{topic.description}</p>}
        {publishedQuestions.length > 0 && (
          <Button variant="primary" onClick={handlePublish} disabled={publishing}>
            <Send className="mr-2 h-4 w-4" />
            {publishing ? '...' : t('topics.publish', 'Publish Topic')}
          </Button>
        )}
      </div>

      {/* Statistics */}
      {statistics && (
        <div className="mb-8 grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">{t('questions.title', 'Questions')}</div>
              <div className="text-2xl font-semibold">
                {statistics.published_questions} / {statistics.total_questions}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">
                {t('answers.respondents', 'Respondents')}
              </div>
              <div className="text-2xl font-semibold">{statistics.total_respondents}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">{t('answers.title', 'Answers')}</div>
              <div className="text-2xl font-semibold">{statistics.total_answers}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">{t('grading.title', 'Grading')}</div>
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
            {t('questions.title', 'Questions')} ({questions.length})
          </TabsTrigger>
          <TabsTrigger value="permissions">
            <Users className="mr-2 h-4 w-4" />
            {t('permissions.title', 'Permissions')}
          </TabsTrigger>
          <TabsTrigger value="grading">
            <BarChart3 className="mr-2 h-4 w-4" />
            {t('grading.title', 'Grading')}
          </TabsTrigger>
          <TabsTrigger value="versions">
            <History className="mr-2 h-4 w-4" />
            {t('topics.versions', 'Versions')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="questions" className="mt-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium">{t('questions.title', 'Questions')}</h2>
            <Button
              variant="outline"
              onClick={() => router.push(`/evaluation/author/topics/${topicId}/questions/new`)}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('questions.add', 'Add Question')}
            </Button>
          </div>

          {questions.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-text-secondary">
                  {t('questions.no_questions', 'No questions yet')}
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => router.push(`/evaluation/author/topics/${topicId}/questions/new`)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {t('questions.create_first', 'Create First Question')}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {questions.map((question, index) => (
                <Card
                  key={question.id}
                  className="cursor-pointer transition-shadow hover:shadow-md"
                  onClick={() =>
                    router.push(`/evaluation/author/topics/${topicId}/questions/${question.id}`)
                  }
                >
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-4">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface text-sm font-medium">
                        {index + 1}
                      </span>
                      <div>
                        <h3 className="font-medium">{question.title}</h3>
                        <span className="text-xs text-text-muted">{question.content_type}</span>
                      </div>
                    </div>
                    <Badge
                      variant={question.status === QuestionStatus.PUBLISHED ? 'success' : 'info'}
                    >
                      {getStatusLabel(question.status, 'question')}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="permissions" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('permissions.management', 'Permission Management')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">
                {t('permissions.description', 'Manage who can view, answer, and grade your topic.')}
              </p>
              <Button
                variant="primary"
                onClick={() => router.push(`/evaluation/author/topics/${topicId}/permissions`)}
              >
                <Users className="mr-2 h-4 w-4" />
                {t('permissions.manage', 'Manage Permissions')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="grading" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('grading.tasks', 'Grading Tasks')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">
                {t('grading.description', 'View and manage AI grading tasks for this topic.')}
              </p>
              <Button
                variant="primary"
                onClick={() => router.push(`/evaluation/topics/${topicId}/grading`)}
              >
                <BarChart3 className="mr-2 h-4 w-4" />
                {t('grading.view_tasks', 'View Grading Tasks')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="versions" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('topics.version_history', 'Version History')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">
                {t(
                  'topics.version_description',
                  'View published versions of this topic and their question snapshots.'
                )}
              </p>
              <Button
                variant="primary"
                onClick={() => router.push(`/evaluation/author/topics/${topicId}/versions`)}
              >
                <History className="mr-2 h-4 w-4" />
                {t('topics.view_versions', 'View Versions')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
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
