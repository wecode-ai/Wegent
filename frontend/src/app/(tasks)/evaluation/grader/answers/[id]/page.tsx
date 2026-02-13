// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Play, Send, Edit, RotateCcw, Save, Link } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import {
  getGraderAnswer,
  getGraderQuestion,
  listGraderTasks,
  getGraderTask,
  executeGraderTask,
  retryGraderTask,
  updateGraderReport,
  publishGraderTask,
} from '@wecode/api/evaluation'
import type { Answer, Question, GradingTask } from '@wecode/types/evaluation'
import { GradingTaskStatus, getStatusLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function GraderAnswerContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const answerId = parseInt(params.id as string)

  const [answer, setAnswer] = useState<Answer | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [gradingTask, setGradingTask] = useState<GradingTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedReport, setEditedReport] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const answerData = await getGraderAnswer(answerId)
      setAnswer(answerData)

      // Load question
      const questionData = await getGraderQuestion(answerData.question_id)
      setQuestion(questionData)

      // Load grading task for this answer
      if (answerData.grading_task_id) {
        const taskData = await getGraderTask(answerData.grading_task_id)
        setGradingTask(taskData)
        // Initialize report content for editing
        if (taskData.report_data) {
          setEditedReport(
            typeof taskData.report_data === 'string'
              ? taskData.report_data
              : JSON.stringify(taskData.report_data, null, 2)
          )
        }
      } else {
        // Try to find grading task by answer_id
        const tasksData = await listGraderTasks({ limit: 1 })
        const task = tasksData.items.find(t => t.answer_id === answerId)
        if (task) {
          const fullTask = await getGraderTask(task.id)
          setGradingTask(fullTask)
          if (fullTask.report_data) {
            setEditedReport(
              typeof fullTask.report_data === 'string'
                ? fullTask.report_data
                : JSON.stringify(fullTask.report_data, null, 2)
            )
          }
        }
      }
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/grader/tasks')
    } finally {
      setLoading(false)
    }
  }, [answerId, toast, router, t])

  useEffect(() => {
    if (answerId) {
      loadData()
    }
  }, [answerId, loadData])

  const handleExecute = async () => {
    if (!gradingTask) return
    setExecuting(true)
    try {
      await executeGraderTask(gradingTask.id)
      toast({
        title: t('grading.execute_success'),
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
      setExecuting(false)
    }
  }

  const handleRetry = async () => {
    if (!gradingTask) return
    setExecuting(true)
    try {
      await retryGraderTask(gradingTask.id)
      toast({
        title: t('grading.execute_success'),
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
      setExecuting(false)
    }
  }

  const handleSaveReport = async () => {
    if (!gradingTask || !editedReport.trim()) return
    setSaving(true)
    try {
      await updateGraderReport(gradingTask.id, { report_content: editedReport.trim() })
      toast({
        title: t('grading.edit_report'),
        description: 'Report saved successfully',
      })
      setIsEditing(false)
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handlePublish = async () => {
    if (!gradingTask) return
    setPublishing(true)
    try {
      await publishGraderTask(gradingTask.id)
      toast({
        title: t('grading.publish_success'),
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

  const getStatusBadgeVariant = (
    status: number
  ): 'default' | 'success' | 'error' | 'info' | 'warning' | 'secondary' => {
    switch (status) {
      case GradingTaskStatus.PENDING:
        return 'secondary'
      case GradingTaskStatus.RUNNING:
        return 'info'
      case GradingTaskStatus.COMPLETED:
        return 'default'
      case GradingTaskStatus.FAILED:
        return 'error'
      case GradingTaskStatus.PUBLISHED:
        return 'success'
      default:
        return 'secondary'
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="mb-4 h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!answer || !question) {
    return null
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push('/evaluation/grader/tasks')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <div className="flex items-center gap-2">
          {gradingTask && (
            <Badge variant={getStatusBadgeVariant(gradingTask.status)}>
              {getStatusLabel(gradingTask.status, 'grading')}
            </Badge>
          )}
        </div>
      </div>

      {/* Question Card */}
      <Card className="mb-6">
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
          {typeof question.criteria_data?.text === 'string' && question.criteria_data.text && (
            <div>
              <h3 className="mb-2 font-medium">{t('questions.criteria')}</h3>
              <p className="whitespace-pre-wrap text-text-secondary">
                {question.criteria_data.text}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Answer Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t('answers.title')}</CardTitle>
          <CardDescription>
            {t('answers.submitted_at')}: {new Date(answer.submitted_at).toLocaleString()}
            {answer.respondent_name && ` - ${answer.respondent_name}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg bg-surface p-4">
            {typeof answer.content_data?.text === 'string' && answer.content_data.text && (
              <p className="whitespace-pre-wrap">{answer.content_data.text}</p>
            )}
            {typeof answer.content_data?.url === 'string' && answer.content_data.url && (
              <div className="flex items-center gap-2">
                <Link className="h-4 w-4 text-primary" />
                <a
                  href={answer.content_data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {answer.content_data.url}
                </a>
              </div>
            )}
            {!answer.content_data?.text && !answer.content_data?.url && (
              <p className="text-text-secondary">{t('answers.no_answers')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Grading Task Card */}
      {gradingTask && (
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t('grading.report')}</CardTitle>
              <div className="flex items-center gap-2">
                {gradingTask.status === GradingTaskStatus.PENDING && (
                  <Button variant="outline" onClick={handleExecute} disabled={executing}>
                    <Play className="mr-2 h-4 w-4" />
                    {t('grading.execute')}
                  </Button>
                )}
                {gradingTask.status === GradingTaskStatus.FAILED && (
                  <Button variant="outline" onClick={handleRetry} disabled={executing}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Retry
                  </Button>
                )}
                {gradingTask.status === GradingTaskStatus.COMPLETED && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setIsEditing(!isEditing)}
                      disabled={publishing}
                    >
                      <Edit className="mr-2 h-4 w-4" />
                      {t('grading.edit_report')}
                    </Button>
                    <Button variant="primary" onClick={handlePublish} disabled={publishing}>
                      <Send className="mr-2 h-4 w-4" />
                      {t('grading.publish')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {gradingTask.status === GradingTaskStatus.RUNNING && (
              <div className="py-8 text-center">
                <p className="text-text-secondary">{t('grading.status.running')}...</p>
              </div>
            )}
            {gradingTask.status === GradingTaskStatus.PENDING && (
              <div className="py-8 text-center">
                <p className="text-text-secondary">{t('grading.status.pending')}</p>
              </div>
            )}
            {gradingTask.status === GradingTaskStatus.FAILED && (
              <div className="py-8 text-center">
                <p className="text-red-500">{t('grading.status.failed')}</p>
                <p className="mt-2 text-sm text-text-secondary">
                  Click retry to re-execute the grading task
                </p>
              </div>
            )}
            {(gradingTask.status === GradingTaskStatus.COMPLETED ||
              gradingTask.status === GradingTaskStatus.PUBLISHED) && (
              <>
                {isEditing ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="report">{t('grading.report')}</Label>
                      <Textarea
                        id="report"
                        value={editedReport}
                        onChange={e => setEditedReport(e.target.value)}
                        rows={12}
                        className="font-mono text-sm"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setIsEditing(false)}>
                        {t('actions.cancel')}
                      </Button>
                      <Button variant="primary" onClick={handleSaveReport} disabled={saving}>
                        <Save className="mr-2 h-4 w-4" />
                        {saving ? '...' : t('actions.save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap rounded-lg bg-surface p-4 text-sm">
                    {typeof gradingTask.report_data === 'string'
                      ? gradingTask.report_data
                      : JSON.stringify(gradingTask.report_data, null, 2)}
                  </pre>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* No grading task */}
      {!gradingTask && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-text-secondary">{t('grading.no_tasks')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default function GraderAnswerPage() {
  return (
    <EvaluationPageLayout>
      <GraderAnswerContent />
    </EvaluationPageLayout>
  )
}
