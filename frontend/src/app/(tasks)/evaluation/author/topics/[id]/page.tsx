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
  Edit,
  History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import {
  getAuthorTopic,
  publishAuthorTopic,
  getAuthorTopicStatistics,
  listAuthorQuestions,
} from '@wecode/api/evaluation-author'
import type { Topic, Question, TopicStatistics } from '@wecode/types/evaluation'
import {
  TopicStatus,
  TopicVisibility,
  QuestionStatus,
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
            onClick={() => router.push(`/evaluation/author/topics/${topicId}/edit`)}
          >
            <Edit className="mr-2 h-4 w-4" />
            {t('actions.edit')}
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
        </div>
        {topic.description && <p className="mb-4 text-text-secondary">{topic.description}</p>}
        {publishedQuestions.length > 0 && (
          <Button variant="primary" onClick={handlePublish} disabled={publishing}>
            <Send className="mr-2 h-4 w-4" />
            {publishing ? '...' : t('topics.publish')}
          </Button>
        )}
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
              <div className="text-sm text-text-secondary">
                {t('answers.respondents')}
              </div>
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
        </TabsList>

        <TabsContent value="questions" className="mt-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium">{t('questions.title')}</h2>
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
                <p className="text-text-secondary">
                  {t('questions.no_questions')}
                </p>
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
                        <span className="text-xs text-text-muted">
                          {t(`questions.content_types.${question.content_type}`)}
                        </span>
                      </div>
                    </div>
                    <Badge
                      variant={question.status === QuestionStatus.PUBLISHED ? 'success' : 'info'}
                    >
                      {getStatusText(question.status, 'question')}
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
              <CardTitle>{t('permissions.management')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">
                {t('permissions.description')}
              </p>
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
          <Card>
            <CardHeader>
              <CardTitle>{t('grading.tasks')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">
                {t('grading.description')}
              </p>
              <Button
                variant="primary"
                onClick={() => router.push(`/evaluation/grader/topics/${topicId}`)}
              >
                <BarChart3 className="mr-2 h-4 w-4" />
                {t('grading.view_tasks')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="versions" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('topics.version_history')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-text-secondary">
                {t('topics.version_description')}
              </p>
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
