// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Send, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  respondentGetQuestion,
  respondentSubmitAnswer,
  listMyAnswers,
  checkVersionUpdate,
} from '@wecode/api/evaluation'
import type { Question, Answer, VersionCheck } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function RespondentQuestionDetailContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.qid as string)

  const [question, setQuestion] = useState<Question | null>(null)
  const [myAnswers, setMyAnswers] = useState<Answer[]>([])
  const [versionCheck, setVersionCheck] = useState<VersionCheck | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // Answer form state
  const [answerText, setAnswerText] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [questionData, answersData, versionData] = await Promise.all([
        respondentGetQuestion(questionId),
        listMyAnswers(questionId),
        checkVersionUpdate(questionId),
      ])
      setQuestion(questionData)
      setMyAnswers(answersData.items)
      setVersionCheck(versionData)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.permission_denied'),
        variant: 'destructive',
      })
      router.push(`/evaluation/respondent/topics/${topicId}`)
    } finally {
      setLoading(false)
    }
  }, [questionId, topicId, toast, router, t])

  useEffect(() => {
    if (questionId && topicId) {
      loadData()
    }
  }, [questionId, topicId, loadData])

  const handleSubmitAnswer = async () => {
    if (!answerText.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: `${t('answers.content')} is required`,
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    try {
      await respondentSubmitAnswer(questionId, {
        content_type: 'text',
        content_text: answerText.trim(),
      })

      toast({
        title: t('answers.submit_success'),
        description: '',
      })
      setAnswerText('')
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="mb-4 h-8 w-1/2" />
        <Skeleton className="mb-8 h-32 w-full" />
      </div>
    )
  }

  if (!question) {
    return null
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <Button
          variant="ghost"
          onClick={() => router.push(`/evaluation/respondent/topics/${topicId}`)}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
      </div>

      {/* Version Update Alert */}
      {versionCheck?.has_new_version && (
        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{t('answers.new_version_available')}</AlertDescription>
        </Alert>
      )}

      {/* Question Card - No grading criteria shown */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>{question.title}</CardTitle>
          <CardDescription>
            {t('questions.content_type')}: {t(`questions.content_types.${question.content_type}`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {typeof question.content_data?.text === 'string' && question.content_data.text && (
            <div>
              <h3 className="mb-2 font-medium">{t('questions.content')}</h3>
              <p className="whitespace-pre-wrap text-text-secondary">
                {question.content_data.text}
              </p>
            </div>
          )}
          {typeof question.content_data?.url === 'string' && question.content_data.url && (
            <div>
              <h3 className="mb-2 font-medium">URL</h3>
              <a
                href={question.content_data.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {question.content_data.url}
              </a>
            </div>
          )}
          {/* NOTE: Grading criteria (criteria_data) is intentionally NOT displayed for respondents */}
        </CardContent>
      </Card>

      {/* Answer Submission Form */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t('answers.submit')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="answerText">{t('answers.content')}</Label>
            <Textarea
              id="answerText"
              value={answerText}
              onChange={e => setAnswerText(e.target.value)}
              placeholder={t('answers.content')}
              rows={8}
            />
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={handleSubmitAnswer} disabled={submitting}>
              {submitting ? '...' : t('answers.submit')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* My Previous Answers */}
      {myAnswers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('answers.history')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {myAnswers.map(answer => (
                <div key={answer.id} className="rounded-lg border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm text-text-secondary">
                      {t('answers.submitted_at')}: {new Date(answer.submitted_at).toLocaleString()}
                    </span>
                    <div className="flex gap-2">
                      {answer.is_latest && <Badge variant="success">{t('answers.latest')}</Badge>}
                      <Badge variant="info">
                        {t('answers.version')}: {answer.question_version}
                      </Badge>
                    </div>
                  </div>
                  <p className="whitespace-pre-wrap">
                    {typeof answer.content_data?.text === 'string' ? answer.content_data.text : ''}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default function RespondentQuestionDetailPage() {
  const isMobile = useIsMobile()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  if (isMobile) {
    return (
      <div className="flex h-dvh flex-col">
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="evaluation"
        />
        <RespondentQuestionDetailContent />
      </div>
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {isSidebarCollapsed ? (
        <CollapsedSidebarButtons
          onExpand={() => setIsSidebarCollapsed(false)}
          onNewTask={() => {}}
        />
      ) : (
        <ResizableSidebar
          minWidth={220}
          maxWidth={400}
          defaultWidth={280}
          storageKey="evaluation-sidebar-width"
        >
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="evaluation"
            isCollapsed={isSidebarCollapsed}
            onToggleCollapsed={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          />
        </ResizableSidebar>
      )}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNavigation activePage="evaluation" />
        <main className="flex-1 overflow-auto">
          <RespondentQuestionDetailContent />
        </main>
      </div>
    </div>
  )
}
