// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, FileCheck, BookOpen, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import { respondentGetTopic, respondentListQuestions } from '@wecode/api/evaluation'
import { respondentGetProgress } from '@wecode/api/evaluation-respondent'
import type { Topic, Question, RespondentProgress } from '@wecode/types/evaluation'
import { TopicVisibility, getVisibilityLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function RespondentTopicDetailContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [progress, setProgress] = useState<RespondentProgress | null>(null)
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, questionsData, progressData] = await Promise.all([
        respondentGetTopic(topicId),
        respondentListQuestions(topicId, { limit: 100 }),
        respondentGetProgress(topicId),
      ])
      setTopic(topicData)
      setQuestions(questionsData.items)
      setProgress(progressData)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.permission_denied'),
        variant: 'destructive',
      })
      router.push('/evaluation/respondent')
    } finally {
      setLoading(false)
    }
  }, [topicId, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

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

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push('/evaluation/respondent')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <Button variant="outline" onClick={() => router.push('/evaluation/respondent/history')}>
          <BookOpen className="mr-2 h-4 w-4" />
          {t('answers.history')}
        </Button>
      </div>

      {/* Topic Info */}
      <div className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-text-primary">{topic.name}</h1>
          <Badge variant={topic.visibility === TopicVisibility.PUBLIC ? 'default' : 'secondary'}>
            {getVisibilityLabel(topic.visibility)}
          </Badge>
        </div>
        {topic.description && <p className="mb-4 text-text-secondary">{topic.description}</p>}
      </div>

      {/* Progress Card */}
      {progress && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              {t('answers.progress.title')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <div className="mb-2 flex justify-between text-sm">
                <span>{t('answers.progress.answered')}</span>
                <span>
                  {progress.answered_questions} / {progress.total_questions}
                </span>
              </div>
              <Progress value={progress.completion_rate * 100} className="h-2" />
            </div>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-semibold">{progress.total_questions}</div>
                <div className="text-xs text-text-muted">{t('answers.progress.total')}</div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{progress.answered_questions}</div>
                <div className="text-xs text-text-muted">{t('answers.progress.answered')}</div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{progress.published_reports}</div>
                <div className="text-xs text-text-muted">{t('answers.progress.reports')}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Questions List */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-medium">{t('questions.title')}</h2>
        <span className="text-sm text-text-muted">
          {questions.length} {t('questions.title').toLowerCase()}
        </span>
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <FileCheck className="mx-auto mb-4 h-12 w-12 text-text-muted" />
            <p className="text-text-secondary">{t('questions.no_questions')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {questions.map((question, index) => (
            <Card
              key={question.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() =>
                router.push(`/evaluation/respondent/topics/${topicId}/questions/${question.id}`)
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
                <Button variant="outline" size="sm">
                  {t('answers.submit')}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RespondentTopicDetailPage() {
  return (
    <EvaluationPageLayout>
      <RespondentTopicDetailContent />
    </EvaluationPageLayout>
  )
}
