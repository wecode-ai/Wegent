// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  Edit,
  RotateCcw,
  Save,
  ClipboardList,
  CheckCircle,
  Loader2,
  Eye,
  EyeOff,
  Bot,
  User,
  AlertTriangle,
  RefreshCw,
  Send,
  Clock,
  Link,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import {
  getGraderAnswer,
  getGraderQuestion,
  listGraderTasks,
  getGraderTask,
  updateGraderReport,
  publishGraderTask,
} from '@wecode/api/evaluation'
import {
  graderUploadReportFile,
  graderPublishTaskWithAttachment,
} from '@wecode/api/evaluation-grader'
import type { Answer, Question, GradingTask, EvalAttachment } from '@wecode/types/evaluation'
import { GradingTaskStatus, getStatusLabel } from '@wecode/types/evaluation'
import { ModelSelectionDialog, MultiStageRetryDialog } from '@wecode/components/evaluation/grader'
import { useGradingActions } from '@wecode/components/evaluation/grader/useGradingActions'
import { useTranslation } from '@/hooks/useTranslation'
import {
  AttachmentList,
  generateEvaluationPrefixedFilename,
} from '@wecode/components/evaluation/common'
import { GraderHeader } from '@wecode/components/evaluation/grader'
import { ExamMarkdownContent } from '@wecode/components/evaluation/exam'
import { isExamQuestionContent, type ExamQuestionContent } from '@wecode/types/evaluation-exam'

// Extract report content from report_data structure
const extractReportContent = (reportData: Record<string, unknown>): string => {
  if (!reportData || Object.keys(reportData).length === 0) {
    return ''
  }

  // Handle direct content string
  if (typeof reportData === 'string') {
    return reportData
  }

  // Handle { content: string } structure
  if (typeof reportData.content === 'string') {
    return reportData.content
  }

  return ''
}

// Get AI report content - check multiple possible field locations
const getAIReportContent = (reportData: Record<string, unknown>): string => {
  if (!reportData) return ''

  // Check ai_report field (preferred)
  const aiReport = reportData.ai_report as Record<string, unknown> | undefined
  if (aiReport) {
    return extractReportContent(aiReport)
  }

  // Fallback: check if reportData itself has content (direct storage)
  if (typeof reportData.content === 'string' && reportData.content) {
    return reportData.content
  }

  // Fallback: check result field
  if (typeof reportData.result === 'string' && reportData.result) {
    return reportData.result
  }

  // Fallback: check value field
  if (typeof reportData.value === 'string' && reportData.value) {
    return reportData.value
  }

  return ''
}

// Get human report content
const getHumanReportContent = (reportData: Record<string, unknown>): string => {
  if (!reportData) return ''
  const humanReport = reportData.human_report as Record<string, unknown> | undefined
  if (humanReport) {
    return extractReportContent(humanReport)
  }
  return ''
}

// Get final report content
const getFinalReportContent = (reportData: Record<string, unknown>): string => {
  if (!reportData) return ''
  const finalReport = reportData.final_report as Record<string, unknown> | undefined
  if (finalReport) {
    return extractReportContent(finalReport)
  }
  return ''
}

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
  const [publishing, setPublishing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedReport, setEditedReport] = useState('')
  const [editedReportVersion, setEditedReportVersion] = useState<number>(1)
  const [showReportPreview, setShowReportPreview] = useState(false)

  // Conflict resolution dialog state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [conflictServerVersion, setConflictServerVersion] = useState<number>(1)
  const [conflictServerReport, setConflictServerReport] = useState('')
  const [pendingSaveContent, setPendingSaveContent] = useState('')

  // Publish dialog state
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishAttachment, setPublishAttachment] = useState<File | null>(null)

  // Model selection dialog state
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [retryDialogOpen, setRetryDialogOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<'execute' | 'retry' | null>(null)

  // Use grading actions hook
  const { executing, executeTask, retryTask } = useGradingActions({
    onSuccess: () => {
      loadData()
    },
  })
  // Generate prefixed filename helper for AttachmentList
  const generatePrefixedFilename = (attachment: EvalAttachment, index: number, slot?: string) => {
    return generateEvaluationPrefixedFilename(attachment, {
      userId: answer?.respondent_id || 0,
      topicId: question?.topic_id || 0,
      questionId: answer?.question_id || 0,
      slot,
      fileIndex: index,
    })
  }

  const loadData = useCallback(
    async (options?: { skipEditedReportUpdate?: boolean }) => {
      const { skipEditedReportUpdate = false } = options || {}
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
          // Initialize report content for editing only when not skipped
          // Priority: human_report > ai_report > empty
          if (taskData.report_data && !skipEditedReportUpdate) {
            const humanContent = getHumanReportContent(taskData.report_data)
            const aiContent = getAIReportContent(taskData.report_data)
            setEditedReport(humanContent || aiContent || '')
          }
          // Track version for optimistic locking
          setEditedReportVersion(taskData.version || 1)
        } else {
          // Try to find grading task by answer_id
          const tasksData = await listGraderTasks({ limit: 100 })
          const task = tasksData.items.find(t => t.answer_id === answerId)
          if (task) {
            const fullTask = await getGraderTask(task.id)
            setGradingTask(fullTask)
            if (fullTask.report_data && !skipEditedReportUpdate) {
              const humanContent = getHumanReportContent(fullTask.report_data)
              const aiContent = getAIReportContent(fullTask.report_data)
              setEditedReport(humanContent || aiContent || '')
            }
            // Track version for optimistic locking
            setEditedReportVersion(fullTask.version || 1)
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
    },
    [answerId, toast, router, t]
  )

  useEffect(() => {
    if (answerId) {
      loadData()
    }
  }, [answerId, loadData])

  // Handle download success/error
  const handleDownloadSuccess = (attachment: EvalAttachment) => {
    toast({
      title: t('common:actions.download') + ' ' + t('common:success'),
      description: attachment.filename,
    })
  }

  const handleDownloadError = () => {
    toast({
      title: t('errors.download_failed'),
      description: '',
      variant: 'destructive',
    })
  }

  // Render exam mode attachments
  const renderExamAttachments = (attachments: Record<string, unknown> | undefined) => {
    if (!attachments) return null

    const elements: React.ReactNode[] = []

    // Define slot labels
    const slotLabels: Record<string, string> = {
      main: t('answers.exam_slots.main') || 'Main Report',
      interaction: t('answers.exam_slots.interaction') || 'Interaction Records',
      bonusAgent: t('answers.exam_slots.bonus_agent') || 'Bonus - Agent',
      bonusMultimodal: t('answers.exam_slots.bonus_multimodal') || 'Bonus - Multimodal',
    }

    // Handle interaction attachments first (array) - Order: interaction -> main -> bonus
    const interactionAttachments = attachments.interaction as EvalAttachment[] | undefined
    if (interactionAttachments && interactionAttachments.length > 0) {
      elements.push(
        <div key="interaction">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">{slotLabels.interaction}</h4>
          <AttachmentList
            attachments={interactionAttachments}
            generatePrefixedFilename={(attachment, index) =>
              generatePrefixedFilename(attachment, index, 'interaction')
            }
            onDownloadSuccess={handleDownloadSuccess}
            onDownloadError={handleDownloadError}
          />
        </div>
      )
    }

    // Handle main attachments (array)
    const mainAttachments = attachments.main as EvalAttachment[] | undefined
    if (mainAttachments && mainAttachments.length > 0) {
      elements.push(
        <div key="main">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">{slotLabels.main}</h4>
          <AttachmentList
            attachments={mainAttachments}
            generatePrefixedFilename={(attachment, index) =>
              generatePrefixedFilename(attachment, index, 'main')
            }
            onDownloadSuccess={handleDownloadSuccess}
            onDownloadError={handleDownloadError}
          />
        </div>
      )
    }

    // Handle bonusAgent (object with link and files)
    const bonusAgent = attachments.bonusAgent as
      | { link?: string; files?: EvalAttachment[] }
      | undefined
    if (bonusAgent && (bonusAgent.link || (bonusAgent.files && bonusAgent.files.length > 0))) {
      elements.push(
        <div key="bonusAgent">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">{slotLabels.bonusAgent}</h4>
          {bonusAgent.link && (
            <div className="mb-2 flex items-center gap-2">
              <Link className="h-4 w-4 text-primary" />
              <a
                href={bonusAgent.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {bonusAgent.link}
              </a>
            </div>
          )}
          {bonusAgent.files && bonusAgent.files.length > 0 && (
            <AttachmentList
              attachments={bonusAgent.files}
              generatePrefixedFilename={(attachment, index) =>
                generatePrefixedFilename(attachment, index, 'bonusAgent')
              }
              onDownloadSuccess={handleDownloadSuccess}
              onDownloadError={handleDownloadError}
            />
          )}
        </div>
      )
    }

    // Handle bonusMultimodal attachments (array)
    const bonusMultimodalAttachments = attachments.bonusMultimodal as EvalAttachment[] | undefined
    if (bonusMultimodalAttachments && bonusMultimodalAttachments.length > 0) {
      elements.push(
        <div key="bonusMultimodal">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">
            {slotLabels.bonusMultimodal}
          </h4>
          <AttachmentList
            attachments={bonusMultimodalAttachments}
            generatePrefixedFilename={(attachment, index) =>
              generatePrefixedFilename(attachment, index, 'bonusMultimodal')
            }
            onDownloadSuccess={handleDownloadSuccess}
            onDownloadError={handleDownloadError}
          />
        </div>
      )
    }

    if (elements.length === 0) return null
    return <div className="space-y-4">{elements}</div>
  }

  // Render content data (text, url, attachments) with Markdown support
  const renderContentData = (
    contentData: Record<string, unknown> | undefined,
    showEmpty: boolean = true
  ) => {
    if (!contentData || Object.keys(contentData).length === 0) {
      return showEmpty ? <p className="text-text-secondary">{t('answers.no_answers')}</p> : null
    }

    const elements: React.ReactNode[] = []

    // Render supplementary notes files first (before exam attachments)
    // In exam mode, supplementary notes files are stored in contentData.attachments.supplementaryNotes
    const attachmentsData = contentData.attachments as Record<string, unknown> | undefined
    const supplementaryNotesFiles = attachmentsData?.supplementaryNotes as
      | EvalAttachment[]
      | undefined
    if (supplementaryNotesFiles && supplementaryNotesFiles.length > 0) {
      elements.push(
        <div key="supplementaryNotesFiles">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">
            {t('answers.supplementary_notes') || 'Answer Notes'}
          </h4>
          <AttachmentList
            attachments={supplementaryNotesFiles}
            generatePrefixedFilename={(attachment, index) =>
              generatePrefixedFilename(attachment, index, 'supplementaryNotes')
            }
            onDownloadSuccess={handleDownloadSuccess}
            onDownloadError={handleDownloadError}
          />
        </div>
      )
    }

    // Render exam attachments (after supplementary notes)
    const examAttachments = renderExamAttachments(
      contentData.attachments as Record<string, unknown>
    )
    if (examAttachments) {
      elements.push(<div key="examAttachments">{examAttachments}</div>)
    }

    // Handle text content - render as Markdown
    if (typeof contentData.text === 'string' && contentData.text) {
      elements.push(
        <div key="text" className="markdown-content">
          <EnhancedMarkdown source={contentData.text} theme={theme === 'dark' ? 'dark' : 'light'} />
        </div>
      )
    }

    // Handle content field (used in question content_data) - render as Markdown
    if (typeof contentData.content === 'string' && contentData.content) {
      elements.push(
        <div key="content" className="markdown-content">
          <EnhancedMarkdown
            source={contentData.content}
            theme={theme === 'dark' ? 'dark' : 'light'}
          />
        </div>
      )
    }

    // Handle contentMarkdown field (used in exam question content_data)
    if (typeof contentData.contentMarkdown === 'string' && contentData.contentMarkdown) {
      elements.push(
        <div key="contentMarkdown" className="markdown-content">
          <EnhancedMarkdown
            source={contentData.contentMarkdown}
            theme={theme === 'dark' ? 'dark' : 'light'}
          />
        </div>
      )
    }

    // Handle criteria field (used in question criteria_data) - render as Markdown
    if (typeof contentData.criteria === 'string' && contentData.criteria) {
      elements.push(
        <div key="criteria" className="markdown-content">
          <EnhancedMarkdown
            source={contentData.criteria}
            theme={theme === 'dark' ? 'dark' : 'light'}
          />
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
          <AttachmentList
            attachments={attachments}
            generatePrefixedFilename={(attachment, index) =>
              generatePrefixedFilename(attachment, index, 'attachments')
            }
            onDownloadSuccess={handleDownloadSuccess}
            onDownloadError={handleDownloadError}
          />
        </div>
      )
    }

    // Handle instructions field (used in question content_data)
    if (typeof contentData.instructions === 'string' && contentData.instructions) {
      elements.push(
        <div key="instructions" className="markdown-content">
          <EnhancedMarkdown
            source={contentData.instructions}
            theme={theme === 'dark' ? 'dark' : 'light'}
          />
        </div>
      )
    }

    // Handle instructionsAttachments field
    const instructionsAttachments = contentData.instructionsAttachments as
      | EvalAttachment[]
      | undefined
    if (instructionsAttachments && instructionsAttachments.length > 0) {
      elements.push(
        <div key="instructionsAttachments">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">
            {t('questions.instructions_attachments') || 'Instruction Attachments'}
          </h4>
          <AttachmentList
            attachments={instructionsAttachments}
            generatePrefixedFilename={(attachment, index) =>
              generatePrefixedFilename(attachment, index, 'instructions')
            }
            onDownloadSuccess={handleDownloadSuccess}
            onDownloadError={handleDownloadError}
          />
        </div>
      )
    }

    // Handle other unknown data by showing JSON
    const knownKeys = [
      'text',
      'content',
      'contentMarkdown',
      'criteria',
      'url',
      'attachments',
      'participantName',
      'selectedTopicId',
      'supplementaryNotes',
      'supplementaryNotesFiles',
      'instructions',
      'instructionsAttachments',
      'display',
      'tasks',
      'requirements',
    ]
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

  const handleRetry = () => {
    if (!gradingTask) return
    setRetryDialogOpen(true)
  }

  const handleExecuteWithModel = async (modelId?: string, forceOverride?: boolean) => {
    if (!gradingTask || !pendingAction) return
    setModelDialogOpen(false)

    try {
      if (pendingAction === 'execute') {
        await executeTask(gradingTask.id, modelId, forceOverride)
      }
    } finally {
      setPendingAction(null)
    }
  }

  const handleRetryWithModel = async (data: {
    gradingMode: 'single' | 'multi'
    modelId?: string
    forceOverride?: boolean
    scorerModels?: { model_id: string; force_override: boolean }[]
    aggregatorModel?: { model_id: string; force_override: boolean }
  }) => {
    if (!gradingTask) return
    setRetryDialogOpen(false)

    await retryTask(gradingTask.id, {
      gradingMode: data.gradingMode,
      modelId: data.modelId,
      forceOverride: data.forceOverride,
      scorerModels: data.scorerModels,
      aggregatorModel: data.aggregatorModel,
    })
  }

  // Extract error message from various error formats
  const extractErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
      // Check if message is a JSON string (from nested detail object)
      try {
        const parsed = JSON.parse(error.message)
        if (parsed.message) {
          return parsed.message
        }
        if (parsed.detail && typeof parsed.detail === 'object' && parsed.detail.message) {
          return parsed.detail.message
        }
      } catch {
        // Not JSON, use message directly
        return error.message
      }
      return error.message
    }
    if (typeof error === 'string') {
      return error
    }
    return String(error)
  }

  const handleSaveReport = async (content?: string, version?: number) => {
    if (!gradingTask) {
      return
    }

    const reportContent = content ?? editedReport.trim()
    if (!reportContent) {
      return
    }

    const reportVersion = version ?? editedReportVersion

    setSaving(true)
    try {
      await updateGraderReport(gradingTask.id, {
        report_content: reportContent,
        version: reportVersion,
      })

      toast({
        title: t('grading.edit_report'),
        description: t('common:actions.save') + ' ' + t('grading.report'),
      })
      setIsEditing(false)
      loadData()
    } catch (error: unknown) {
      const errorMessage = extractErrorMessage(error)

      // Check for 409 conflict error - check both the message and the raw error structure
      const isConflictError =
        errorMessage.includes('modified by another user') ||
        (error instanceof Error && error.message.includes('modified by another user')) ||
        (error instanceof Error && error.message.includes('"current_version"'))

      if (isConflictError) {
        // Parse error details from the error message or re-fetch to get current data
        try {
          const currentTask = await getGraderTask(gradingTask.id)
          const serverVersion = currentTask.version || 1
          const serverReportContent =
            getHumanReportContent(currentTask.report_data) ||
            getAIReportContent(currentTask.report_data) ||
            ''

          setConflictServerVersion(serverVersion)
          setConflictServerReport(serverReportContent)
          setPendingSaveContent(reportContent)
          setConflictDialogOpen(true)
        } catch {
          toast({
            title: t('errors.save_failed'),
            description:
              t('grading.conflict_error') || 'Conflict detected but failed to load server version',
            variant: 'destructive',
          })
        }
      } else {
        toast({
          title: t('errors.save_failed'),
          description: errorMessage,
          variant: 'destructive',
        })
      }
    } finally {
      setSaving(false)
    }
  }

  // Handle conflict resolution choices
  const handleConflictViewServer = () => {
    // Load server version into editor
    setEditedReport(conflictServerReport)
    setEditedReportVersion(conflictServerVersion)
    setConflictDialogOpen(false)
    toast({
      title: t('grading.conflict_resolved') || 'Server version loaded',
      description:
        t('grading.server_version_loaded') ||
        'The server version has been loaded. Review and save again.',
    })
  }

  const handleConflictOverwrite = async () => {
    setConflictDialogOpen(false)
    // Retry save with server version (force overwrite)
    await handleSaveReport(pendingSaveContent, conflictServerVersion)
  }

  const handleConflictCancel = () => {
    setConflictDialogOpen(false)
    // Keep current editor content, user can review and try again
    toast({
      title: t('grading.conflict_cancelled') || 'Save cancelled',
      description:
        t('grading.conflict_keep_editing') || 'You can review the content and try saving again.',
    })
  }

  // Check if task can be published (has human report or is completed)
  const canPublish = (task: GradingTask): boolean => {
    const humanContent = getHumanReportContent(task.report_data)
    const hasHumanReport = !!humanContent && humanContent.trim().length > 0
    const isCompleted = task.status === GradingTaskStatus.COMPLETED
    const isPendingOrFailed =
      task.status === GradingTaskStatus.PENDING || task.status === GradingTaskStatus.FAILED
    return isCompleted || (isPendingOrFailed && hasHumanReport)
  }

  // Check if task has any report content (AI or human)
  const hasAnyReport = (task: GradingTask): boolean => {
    const aiContent = getAIReportContent(task.report_data)
    const humanContent = getHumanReportContent(task.report_data)
    return !!(aiContent?.trim() || humanContent?.trim())
  }

  const handlePublishClick = () => {
    if (!gradingTask) return

    // Check if task can be published
    if (!canPublish(gradingTask)) {
      toast({
        title: t('grading.publish_error') || 'Cannot Publish',
        description:
          t('grading.publish_error_no_report') ||
          'Please edit and save a report, or wait for AI grading to complete.',
        variant: 'destructive',
      })
      return
    }

    // Open publish dialog
    setPublishAttachment(null)
    setPublishDialogOpen(true)
  }

  const handleConfirmPublish = async () => {
    if (!gradingTask) return

    setPublishing(true)
    try {
      if (publishAttachment) {
        // Upload file and publish with attachment
        const uploadResponse = await graderUploadReportFile(gradingTask.id, publishAttachment)
        await graderPublishTaskWithAttachment(gradingTask.id, {
          key: uploadResponse.key,
          filename: uploadResponse.filename,
          size: uploadResponse.file_size,
          contentType: uploadResponse.content_type,
        })
      } else {
        // Publish without attachment
        await publishGraderTask(gradingTask.id)
      }

      toast({
        title: t('grading.publish_success'),
        description: '',
      })
      setPublishDialogOpen(false)
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

  // Get human report status info
  const getHumanReportStatus = (reportData: Record<string, unknown> | undefined) => {
    if (!reportData) return { hasHumanReport: false, isPublished: false }

    const humanContent = getHumanReportContent(reportData)
    const finalContent = getFinalReportContent(reportData)

    return {
      hasHumanReport: !!humanContent && humanContent.trim().length > 0,
      isPublished: !!finalContent && finalContent.trim().length > 0,
    }
  }

  // Render report content using Tabs
  const renderReportContent = (reportData: Record<string, unknown>) => {
    if (!reportData || Object.keys(reportData).length === 0) {
      return <p className="text-text-secondary">{t('grading.no_report_data')}</p>
    }

    const aiContent = getAIReportContent(reportData)
    const humanContent = getHumanReportContent(reportData)
    const finalContent = getFinalReportContent(reportData)

    // If no reports at all
    if (!aiContent && !humanContent && !finalContent) {
      return <p className="text-text-secondary">{t('grading.no_report_data')}</p>
    }

    // Determine default tab - priority: final > human > ai
    let defaultTab = ''
    if (finalContent) {
      defaultTab = 'final'
    } else if (humanContent) {
      defaultTab = 'human'
    } else if (aiContent) {
      defaultTab = 'ai'
    }

    return (
      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList
          className="grid w-full"
          style={{
            gridTemplateColumns: `repeat(${[finalContent, humanContent, aiContent].filter(Boolean).length}, 1fr)`,
          }}
        >
          {finalContent && (
            <TabsTrigger value="final" className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              {t('grading.final_report') || 'Final Report'}
            </TabsTrigger>
          )}
          {humanContent && (
            <TabsTrigger value="human" className="flex items-center gap-2">
              <User className="h-4 w-4" />
              {t('grading.human_report') || 'Human Report'}
            </TabsTrigger>
          )}
          {aiContent && (
            <TabsTrigger value="ai" className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              {t('grading.ai_report') || 'AI Report'}
            </TabsTrigger>
          )}
        </TabsList>

        {finalContent && (
          <TabsContent value="final" className="mt-4">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              <div className="markdown-content">
                <EnhancedMarkdown
                  source={finalContent}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
            </div>
          </TabsContent>
        )}

        {humanContent && (
          <TabsContent value="human" className="mt-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-900/20">
              <div className="markdown-content">
                <EnhancedMarkdown
                  source={humanContent}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
            </div>
          </TabsContent>
        )}

        {aiContent && (
          <TabsContent value="ai" className="mt-4">
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-900/20">
              <div className="markdown-content">
                {aiContent === 'AI grading completed (recovered)' ? (
                  <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
                    <Bot className="h-12 w-12 text-text-muted" />
                    <div>
                      <p className="mb-2 text-text-secondary">
                        {t('grading.ai_recovered_message') ||
                          'AI grading task was recovered, but the report content was not saved.'}
                      </p>
                      {gradingTask?.task_id && (
                        <Button
                          variant="outline"
                          onClick={() => router.push(`/chat?taskId=${gradingTask.task_id}`)}
                        >
                          <Bot className="mr-2 h-4 w-4" />
                          {t('grading.view_chat_task') || 'View Chat Task'}
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <EnhancedMarkdown
                    source={aiContent}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                  />
                )}
              </div>
            </div>
          </TabsContent>
        )}
      </Tabs>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafbfc]">
        <GraderHeader title={t('answers.view')} isLoading={true} />
        <main className="max-w-4xl mx-auto px-4 sm:px-8 py-8">
          <Skeleton className="mb-4 h-48 w-full rounded-2xl" />
          <Skeleton className="mb-4 h-48 w-full rounded-2xl" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </main>
      </div>
    )
  }

  if (!answer || !question) {
    return null
  }

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      <main className="max-w-4xl mx-auto px-4 sm:px-8 py-8 space-y-6">
        {/* Header */}
        <GraderHeader
          title={question.title}
          description={
            answer.respondent_name
              ? `${t('permissions.user')}: ${answer.respondent_name}`
              : undefined
          }
          backHref="/evaluation/grader"
          actions={
            <div className="flex items-center gap-2">
              {gradingTask && (
                <>
                  {/* Task Status - Unified display */}
                  {(() => {
                    const { hasHumanReport, isPublished } = getHumanReportStatus(
                      gradingTask.report_data
                    )

                    // Published state - show single unified status
                    if (gradingTask.status === GradingTaskStatus.PUBLISHED || isPublished) {
                      return <Badge variant="success">{t('grading.status.published')}</Badge>
                    }

                    // Has human report draft - show draft status
                    if (hasHumanReport) {
                      return (
                        <Badge variant="warning">
                          {t('grading.human_report_draft') || 'Draft'}
                        </Badge>
                      )
                    }

                    // AI grading status for other states
                    return (
                      <Badge variant={getStatusBadgeVariant(gradingTask.status)}>
                        {getStatusLabel(gradingTask.status, 'grading', t)}
                      </Badge>
                    )
                  })()}
                </>
              )}
            </div>
          }
        />

        {/* Question Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-bold text-gray-900">{t('questions.question_content')}</h2>
            <p className="text-sm text-gray-500 mt-1">
              {t('questions.content_type')}: {t(`questions.content_types.${question.content_type}`)}
            </p>
          </div>
          <div>
            {/* Question Content */}
            {(() => {
              // Check if this is exam-style question content
              if (isExamQuestionContent(question.content_data)) {
                const examContent = question.content_data as ExamQuestionContent
                return (
                  <ExamMarkdownContent
                    icon={examContent.display?.icon}
                    title={question.title}
                    content={examContent.contentMarkdown}
                    className="shadow-none bg-transparent"
                  />
                )
              }
              // Fall back to standard content rendering
              return (
                <div className="p-6">
                  <div className="rounded-xl bg-gray-50 p-4">
                    {renderContentData(question.content_data, false) || (
                      <p className="text-gray-500">{t('questions.no_content')}</p>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* Grading Criteria - Important for graders */}
          {question.criteria_data && Object.keys(question.criteria_data).length > 0 && (
            <div className="px-6 pb-6">
              <h3 className="mb-2 flex items-center gap-2 font-medium text-gray-900">
                <ClipboardList className="h-4 w-4 text-gray-500" />
                {t('questions.criteria')}
              </h3>
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                {renderContentData(question.criteria_data, false) || (
                  <p className="text-gray-500">{t('questions.no_criteria')}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Answer Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-bold text-gray-900">{t('answers.title')}</h2>
            <p className="text-sm text-gray-500 mt-1">
              {t('answers.submitted_at')}: {new Date(answer.submitted_at).toLocaleString()}
              {answer.respondent_name && ` - ${answer.respondent_name}`}
            </p>
          </div>
          <div className="p-6">
            <div className="rounded-xl bg-gray-50 p-4">
              {renderContentData(answer.content_data)}
            </div>
          </div>
        </div>

        {/* Grading Task Card */}
        {gradingTask && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-lg font-bold text-gray-900">{t('grading.report')}</h2>
                <div className="flex flex-wrap items-center gap-2">
                  {/* AI Grading Actions - Only show when grading bot is configured */}
                  {gradingTask.team_id > 0 && (
                    <Button
                      variant="outline"
                      onClick={handleRetry}
                      disabled={executing}
                      className="h-9"
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      {t('grading.retry')}
                    </Button>
                  )}
                  {/* Navigate to chat task - Show if task_id exists */}
                  {gradingTask.task_id > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => router.push(`/chat?taskId=${gradingTask.task_id}`)}
                      title={t('grading.view_chat_task')}
                    >
                      <Bot className="mr-2 h-4 w-4" />
                      {t('grading.view_chat')}
                    </Button>
                  )}
                  {gradingTask.team_id === 0 && (
                    <span className="text-sm text-text-muted">
                      {t('grading.manual_only') || 'Manual grading only'}
                    </span>
                  )}

                  {/* Manual Report Management - Always Available */}
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (!isEditing) {
                        // Entering edit mode - refresh task data to get latest version
                        try {
                          const freshTask = await getGraderTask(gradingTask.id)
                          setGradingTask(freshTask)
                          // Initialize editedReport from fresh data
                          if (freshTask.report_data) {
                            const humanContent = getHumanReportContent(freshTask.report_data)
                            const aiContent = getAIReportContent(freshTask.report_data)
                            setEditedReport(humanContent || aiContent || '')
                          } else {
                            setEditedReport('')
                          }
                          // Initialize version for optimistic locking from fresh data
                          setEditedReportVersion(freshTask.version || 1)
                        } catch {
                          // Fallback to current data if refresh fails
                          if (gradingTask?.report_data) {
                            const humanContent = getHumanReportContent(gradingTask.report_data)
                            const aiContent = getAIReportContent(gradingTask.report_data)
                            setEditedReport(humanContent || aiContent || '')
                          } else {
                            setEditedReport('')
                          }
                          setEditedReportVersion(gradingTask?.version || 1)
                        }
                      }
                      setIsEditing(!isEditing)
                    }}
                    disabled={publishing}
                  >
                    <Edit className="mr-2 h-4 w-4" />
                    {isEditing ? t('common:actions.cancel') : t('grading.edit_report')}
                  </Button>

                  {gradingTask.status !== GradingTaskStatus.PUBLISHED && (
                    <Button
                      variant="primary"
                      onClick={handlePublishClick}
                      disabled={publishing || isEditing || !canPublish(gradingTask)}
                      title={
                        canPublish(gradingTask)
                          ? t('grading.publish_hint') || 'Publish the grading report'
                          : t('grading.publish_disabled_hint') ||
                            'Please edit and save a report before publishing'
                      }
                      className="h-9"
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      {publishing ? '...' : t('grading.publish')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <div className="p-6">
              {/* Status Alerts - Compact notice style */}
              {gradingTask.status === GradingTaskStatus.RUNNING && (
                <div
                  className="mb-4 flex cursor-pointer items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3 text-sm text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/30"
                  onClick={() =>
                    gradingTask.task_id > 0 && router.push(`/chat?taskId=${gradingTask.task_id}`)
                  }
                  title={
                    gradingTask.task_id > 0 ? t('grading.view_chat') || '点击查看聊天任务' : ''
                  }
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t('grading.status.running')}...</span>
                  {gradingTask.task_id > 0 && (
                    <span className="ml-auto text-xs text-blue-600/70 dark:text-blue-400/70">
                      {t('grading.click_to_view') || '点击查看'}
                    </span>
                  )}
                </div>
              )}
              {gradingTask.status === GradingTaskStatus.PENDING &&
                !getHumanReportStatus(gradingTask.report_data).hasHumanReport && (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-300">
                    <Clock className="h-4 w-4" />
                    <span>{t('grading.status.pending')}</span>
                  </div>
                )}
              {gradingTask.status === GradingTaskStatus.FAILED && (
                <div className="mb-4 rounded-lg border border-red-200 bg-red-50/50 px-4 py-3 dark:border-red-900 dark:bg-red-900/20">
                  <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
                    <AlertTriangle className="h-4 w-4" />
                    <span className="font-medium">{t('grading.status.failed')}</span>
                  </div>
                  {gradingTask.error_message && (
                    <p className="mt-1 pl-6 text-sm text-red-600/80 dark:text-red-400/80">
                      {gradingTask.error_message}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2 pl-6">
                    <span className="text-xs text-text-muted">{t('grading.retry_hint')}</span>
                    {gradingTask.task_id > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => router.push(`/chat?taskId=${gradingTask.task_id}`)}
                        title={t('grading.view_execution_task_hint')}
                      >
                        {t('grading.view_execution_task')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {/* Report Content - Always show editing interface */}
              {isEditing ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="report">{t('grading.report_content')} (Markdown)</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowReportPreview(!showReportPreview)}
                      >
                        {showReportPreview ? (
                          <>
                            <EyeOff className="mr-1 h-4 w-4" />
                            {t('common:actions.edit')}
                          </>
                        ) : (
                          <>
                            <Eye className="mr-1 h-4 w-4" />
                            {t('grading.preview') || 'Preview'}
                          </>
                        )}
                      </Button>
                    </div>

                    {showReportPreview ? (
                      <div className="min-h-[400px] rounded-xl border border-gray-200 bg-gray-50 p-4">
                        {editedReport.trim() ? (
                          <div className="markdown-content">
                            <EnhancedMarkdown
                              source={editedReport}
                              theme={theme === 'dark' ? 'dark' : 'light'}
                            />
                          </div>
                        ) : (
                          <p className="text-gray-500">{t('grading.no_report_data')}</p>
                        )}
                      </div>
                    ) : (
                      <Textarea
                        id="report"
                        value={editedReport}
                        onChange={e => setEditedReport(e.target.value)}
                        rows={18}
                        className="font-mono text-sm"
                        placeholder={
                          t('grading.report_content_placeholder') ||
                          'Enter grading report content here...'
                        }
                      />
                    )}

                    <p className="text-xs text-gray-500">
                      {t(
                        'grading.markdown_hint',
                        'Supports Markdown formatting: **bold**, *italic*, `code`, lists, etc.'
                      )}
                    </p>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setIsEditing(false)}>
                      {t('common:actions.cancel')}
                    </Button>
                    <Button variant="primary" onClick={() => handleSaveReport()} disabled={saving}>
                      <Save className="mr-2 h-4 w-4" />
                      {saving ? '...' : t('common:actions.save')}
                    </Button>
                  </div>
                </div>
              ) : (
                renderReportContent(gradingTask.report_data)
              )}
            </div>
          </div>
        )}

        {/* No grading task */}
        {!gradingTask && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-8 text-center">
              <p className="text-gray-500">{t('grading.no_tasks')}</p>
            </div>
          </div>
        )}

        {/* Conflict Resolution Dialog */}
        <Dialog open={conflictDialogOpen} onOpenChange={setConflictDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                <DialogTitle>
                  {t('grading.conflict_title') || 'Report Modified by Another User'}
                </DialogTitle>
              </div>
              <DialogDescription>
                {t('grading.conflict_description') ||
                  'This report has been modified by another user while you were editing. How would you like to resolve this conflict?'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-900/20">
                <p className="text-sm text-text-secondary">
                  {t('grading.conflict_info') ||
                    'Your changes could not be saved because the report was updated by someone else. You can:'}
                </p>
                <ul className="mt-2 list-inside list-disc text-sm text-text-secondary">
                  <li>
                    {t('grading.conflict_option_view') ||
                      'Load the server version and continue editing based on it'}
                  </li>
                  <li>
                    {t('grading.conflict_option_overwrite') ||
                      "Overwrite the server version with your changes (may lose others' work)"}
                  </li>
                  <li>
                    {t('grading.conflict_option_cancel') ||
                      'Cancel and keep editing your current version'}
                  </li>
                </ul>
              </div>
            </div>

            <DialogFooter className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={handleConflictCancel} className="w-full sm:w-auto">
                {t('common:actions.cancel')}
              </Button>
              <Button
                variant="outline"
                onClick={handleConflictViewServer}
                className="w-full sm:w-auto"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('grading.conflict_load_server') || 'Load Server Version'}
              </Button>
              <Button
                variant="primary"
                onClick={handleConflictOverwrite}
                className="w-full sm:w-auto"
              >
                <Save className="mr-2 h-4 w-4" />
                {t('grading.conflict_overwrite') || 'Overwrite'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Publish Dialog */}
        <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {t('grading.publish_dialog_title') || 'Publish Grading Report'}
              </DialogTitle>
              <DialogDescription>
                {t('grading.publish_dialog_description') ||
                  'Review the report content before publishing. You can also attach an additional file as the final report.'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Report Preview */}
              <div className="rounded-lg border border-border bg-surface p-4">
                <h4 className="mb-2 text-sm font-medium">
                  {t('grading.report_preview') || 'Report Preview'}
                </h4>
                <div className="max-h-48 overflow-auto text-sm text-text-secondary">
                  {(() => {
                    const aiContent = gradingTask ? getAIReportContent(gradingTask.report_data) : ''
                    const humanContent = gradingTask
                      ? getHumanReportContent(gradingTask.report_data)
                      : ''
                    const content = humanContent || aiContent
                    if (content) {
                      return (
                        <div className="markdown-content">
                          <EnhancedMarkdown
                            source={content.slice(0, 500) + (content.length > 500 ? '...' : '')}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        </div>
                      )
                    }
                    return <p>{t('grading.no_report_data')}</p>
                  })()}
                </div>
              </div>

              {/* Attachment Upload */}
              <div className="space-y-2">
                <Label htmlFor="attachment">
                  {t('grading.attachment_optional') || 'Attachment (Optional)'}
                </Label>
                <input
                  type="file"
                  id="attachment"
                  onChange={e => setPublishAttachment(e.target.files?.[0] || null)}
                  className="block w-full text-sm text-text-secondary file:mr-4 file:rounded file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-primary/90"
                  accept=".md,.txt,.markdown,.pdf,.doc,.docx"
                />
                <p className="text-xs text-text-muted">
                  {t('grading.attachment_hint') ||
                    'Upload a file to use as the final report. If not provided, the edited report will be used.'}
                </p>
                {publishAttachment && (
                  <p className="text-sm text-text-secondary">
                    {t('grading.selected_file') || 'Selected'}: {publishAttachment.name} (
                    {(publishAttachment.size / 1024).toFixed(1)} KB)
                  </p>
                )}
              </div>
            </div>

            <DialogFooter className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => setPublishDialogOpen(false)}
                className="w-full sm:w-auto"
              >
                {t('common:actions.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleConfirmPublish}
                disabled={publishing || (!hasAnyReport(gradingTask!) && !publishAttachment)}
                className="w-full sm:w-auto"
              >
                <Send className="mr-2 h-4 w-4" />
                {publishing
                  ? t('grading.publishing') || 'Publishing...'
                  : t('grading.confirm_publish') || 'Confirm Publish'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Model Selection Dialog - For Execute */}
        <ModelSelectionDialog
          open={modelDialogOpen}
          onOpenChange={setModelDialogOpen}
          topicId={question?.topic_id || null}
          onConfirm={handleExecuteWithModel}
          title={t('grading.select_model_title')}
          description={t('grading.select_model_description')}
          confirmText={t('grading.start_grading')}
          loading={executing}
        />

        {/* Multi-Stage Retry Dialog - For Retry */}
        <MultiStageRetryDialog
          open={retryDialogOpen}
          onOpenChange={setRetryDialogOpen}
          topicId={question?.topic_id || null}
          onConfirm={handleRetryWithModel}
          title={t('grading.retry_config')}
          confirmText={t('grading.retry')}
          loading={executing}
        />
      </main>
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
