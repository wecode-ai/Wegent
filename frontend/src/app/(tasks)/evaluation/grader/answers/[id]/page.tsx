// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  Play,
  Send,
  Edit,
  RotateCcw,
  Save,
  Link,
  File,
  Download,
  FileText,
  ClipboardList,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
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
import {
  graderGetReportUploadUrl,
  uploadFileToPresignedUrl,
  graderPublishTaskWithAttachment,
} from '@wecode/api/evaluation-grader'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import type { Answer, Question, GradingTask, EvalAttachment } from '@wecode/types/evaluation'
import { GradingTaskStatus, getStatusLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { formatFileSize } from '@/apis/attachments'

function GraderAnswerContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const answerId = parseInt(params.id as string)

  const [answer, setAnswer] = useState<Answer | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [gradingTask, setGradingTask] = useState<GradingTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedReport, setEditedReport] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

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
          const reportContent =
            typeof taskData.report_data === 'string'
              ? taskData.report_data
              : typeof taskData.report_data.content === 'string'
                ? taskData.report_data.content
                : JSON.stringify(taskData.report_data, null, 2)
          setEditedReport(reportContent)
        }
      } else {
        // Try to find grading task by answer_id
        const tasksData = await listGraderTasks({ limit: 100 })
        const task = tasksData.items.find(t => t.answer_id === answerId)
        if (task) {
          const fullTask = await getGraderTask(task.id)
          setGradingTask(fullTask)
          if (fullTask.report_data) {
            const reportContent =
              typeof fullTask.report_data === 'string'
                ? fullTask.report_data
                : typeof fullTask.report_data.content === 'string'
                  ? fullTask.report_data.content
                  : JSON.stringify(fullTask.report_data, null, 2)
            setEditedReport(reportContent)
          }
        }
      }
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/grader')
    } finally {
      setLoading(false)
    }
  }, [answerId, toast, router, t])

  useEffect(() => {
    if (answerId) {
      loadData()
    }
  }, [answerId, loadData])

  // Handle attachment download
  const handleDownload = async (attachment: EvalAttachment) => {
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (_error) {
      toast({
        title: t('errors.download_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }

  // Render attachment list
  const renderAttachmentList = (attachments: EvalAttachment[] | undefined) => {
    if (!attachments || attachments.length === 0) return null
    return (
      <div className="space-y-2">
        {attachments.map((attachment, index) => (
          <div
            key={attachment.key || index}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
          >
            <File className="h-4 w-4 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
            {attachment.file_size && (
              <span className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleDownload(attachment)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    )
  }

  // Render content data (text, url, attachments)
  const renderContentData = (
    contentData: Record<string, unknown> | undefined,
    showEmpty: boolean = true
  ) => {
    if (!contentData || Object.keys(contentData).length === 0) {
      return showEmpty ? <p className="text-text-secondary">{t('answers.no_answers')}</p> : null
    }

    const elements: React.ReactNode[] = []

    // Handle text content
    if (typeof contentData.text === 'string' && contentData.text) {
      elements.push(
        <div key="text">
          <p className="whitespace-pre-wrap">{contentData.text}</p>
        </div>
      )
    }

    // Handle URL content
    if (typeof contentData.url === 'string' && contentData.url) {
      elements.push(
        <div key="url" className="flex items-center gap-2">
          <Link className="h-4 w-4 text-primary" />
          <a
            href={contentData.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {contentData.url}
          </a>
        </div>
      )
    }

    // Handle attachments
    const attachments = contentData.attachments as EvalAttachment[] | undefined
    if (attachments && attachments.length > 0) {
      elements.push(
        <div key="attachments">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">
            {t('questions.attachments')}
          </h4>
          {renderAttachmentList(attachments)}
        </div>
      )
    }

    // Handle other unknown data by showing JSON
    const knownKeys = ['text', 'url', 'attachments']
    const otherKeys = Object.keys(contentData).filter(k => !knownKeys.includes(k))
    if (otherKeys.length > 0 && elements.length === 0) {
      elements.push(
        <pre key="json" className="whitespace-pre-wrap text-sm">
          {JSON.stringify(contentData, null, 2)}
        </pre>
      )
    }

    if (elements.length === 0) {
      return showEmpty ? <p className="text-text-secondary">{t('answers.no_answers')}</p> : null
    }

    return <div className="space-y-4">{elements}</div>
  }

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
        description: t('actions.save') + ' ' + t('grading.report'),
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

  // Handle file upload and publish with attachment
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !gradingTask) return

    setUploading(true)
    try {
      // Get presigned URL for upload
      const { upload_url, key } = await graderGetReportUploadUrl(
        gradingTask.id,
        file.name,
        file.type
      )

      // Upload file to presigned URL
      const uploadSuccess = await uploadFileToPresignedUrl(upload_url, file)
      if (!uploadSuccess) {
        throw new Error('Upload failed')
      }

      // Publish with attachment
      await graderPublishTaskWithAttachment(gradingTask.id, {
        key,
        filename: file.name,
        size: file.size,
        contentType: file.type,
      })

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
      setUploading(false)
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
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

  // Render report content using EnhancedMarkdown
  const renderReportContent = (reportData: Record<string, unknown>) => {
    if (!reportData || Object.keys(reportData).length === 0) {
      return <p className="text-text-secondary">{t('grading.no_report_data')}</p>
    }

    // Extract content string from different report_data structures
    let content = ''
    if (typeof reportData === 'string') {
      content = reportData
    } else if (typeof reportData.content === 'string') {
      content = reportData.content
    } else {
      content = JSON.stringify(reportData, null, 2)
    }

    return (
      <div className="rounded-lg bg-surface p-4">
        <EnhancedMarkdown source={content} theme={theme === 'dark' ? 'dark' : 'light'} />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="mb-4 h-48 w-full" />
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
        <Button variant="ghost" onClick={() => router.push('/evaluation/grader')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <div className="flex items-center gap-2">
          {gradingTask && (
            <Badge variant={getStatusBadgeVariant(gradingTask.status)}>
              {getStatusLabel(gradingTask.status, 'grading', t)}
            </Badge>
          )}
        </div>
      </div>

      {/* Question Card */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <CardTitle>{question.title}</CardTitle>
          </div>
          <CardDescription>
            {t('questions.content_type')}: {t(`questions.content_types.${question.content_type}`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Question Content */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 font-medium">
              <FileText className="h-4 w-4" />
              {t('questions.content')}
            </h3>
            <div className="rounded-lg bg-surface p-4">
              {renderContentData(question.content_data, false) || (
                <p className="text-text-secondary">{t('questions.no_content')}</p>
              )}
            </div>
          </div>

          {/* Grading Criteria - Important for graders */}
          {question.criteria_data && Object.keys(question.criteria_data).length > 0 && (
            <div>
              <h3 className="mb-2 flex items-center gap-2 font-medium">
                <ClipboardList className="h-4 w-4" />
                {t('questions.criteria')}
              </h3>
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                {renderContentData(question.criteria_data, false) || (
                  <p className="text-text-secondary">{t('questions.no_criteria')}</p>
                )}
              </div>
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
            {renderContentData(answer.content_data)}
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
                    {t('grading.retry')}
                  </Button>
                )}
                {gradingTask.status === GradingTaskStatus.COMPLETED && (
                  <>
                    <Button variant="outline" onClick={handleRetry} disabled={executing}>
                      <RotateCcw className="mr-2 h-4 w-4" />
                      {t('grading.retry')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setIsEditing(!isEditing)}
                      disabled={publishing}
                    >
                      <Edit className="mr-2 h-4 w-4" />
                      {t('grading.edit_report')}
                    </Button>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      className="hidden"
                      accept=".pdf,.doc,.docx,.md,.txt"
                    />
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      {t('grading.upload_report')}
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
                {gradingTask.error_message && (
                  <p className="mt-2 text-sm text-text-secondary">{gradingTask.error_message}</p>
                )}
                <p className="mt-2 text-sm text-text-secondary">{t('grading.retry_hint')}</p>
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
                  renderReportContent(gradingTask.report_data)
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
