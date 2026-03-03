// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  Play,
  Edit,
  RotateCcw,
  Save,
  Link,
  File,
  Download,
  FileText,
  ClipboardList,
  Upload,
  CheckCircle,
  Loader2,
  Eye,
  EyeOff,
  Bot,
  User,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
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
  executeGraderTask,
  retryGraderTask,
  updateGraderReport,
  publishGraderTask,
} from '@wecode/api/evaluation'
import {
  graderUploadReportFile,
  graderPublishTaskWithAttachment,
} from '@wecode/api/evaluation-grader'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import type { Answer, Question, GradingTask, EvalAttachment } from '@wecode/types/evaluation'
import { GradingTaskStatus, getStatusLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { formatFileSize } from '@/apis/attachments'

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

// Get AI report content - only returns content if ai_report field explicitly exists
const getAIReportContent = (reportData: Record<string, unknown>): string => {
  if (!reportData) return ''
  const aiReport = reportData.ai_report as Record<string, unknown> | undefined
  if (aiReport) {
    return extractReportContent(aiReport)
  }
  // No fallback - only return content if ai_report field exists
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
  const [executing, setExecuting] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedReport, setEditedReport] = useState('')
  const [editedReportVersion, setEditedReportVersion] = useState<number>(1)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  const [showReportPreview, setShowReportPreview] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Conflict resolution dialog state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [conflictServerVersion, setConflictServerVersion] = useState<number>(1)
  const [conflictServerReport, setConflictServerReport] = useState('')
  const [pendingSaveContent, setPendingSaveContent] = useState('')

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

  // Generate prefixed filename for download
  const generatePrefixedFilename = (
    attachment: EvalAttachment,
    slot?: string,
    fileIndex?: number
  ): string => {
    const userId = answer?.respondent_id || 0
    const topicId = question?.topic_id || 0
    const questionId = answer?.question_id || 0
    const slotName = slot || 'attachment'
    const index = fileIndex !== undefined ? fileIndex + 1 : 1
    const originalFilename = attachment.filename || 'download'

    return `${userId}_${topicId}_${questionId}_${slotName}_${index}_${originalFilename}`
  }

  // Handle attachment download with progress
  const handleDownload = async (attachment: EvalAttachment, slot?: string, fileIndex?: number) => {
    const downloadKey = `${attachment.key}_${fileIndex ?? 0}`
    setDownloadingKey(downloadKey)

    try {
      const prefixedFilename = generatePrefixedFilename(attachment, slot, fileIndex)
      await downloadEvaluationFile(attachment.key, prefixedFilename)
      toast({
        title: t('common:actions.download') + ' ' + t('common:success'),
        description: attachment.filename,
      })
    } catch (_error) {
      toast({
        title: t('errors.download_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setDownloadingKey(null)
    }
  }

  // Render attachment list
  const renderAttachmentList = (attachments: EvalAttachment[] | undefined, slot?: string) => {
    if (!attachments || attachments.length === 0) return null
    return (
      <div className="space-y-2">
        {attachments.map((attachment, index) => {
          const downloadKey = `${attachment.key}_${index}`
          const isDownloading = downloadingKey === downloadKey
          return (
            <div
              key={attachment.key || index}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
            >
              <File className="h-4 w-4 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
              {attachment.file_size && (
                <span className="text-xs text-text-muted">
                  {formatFileSize(attachment.file_size)}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => handleDownload(attachment, slot, index)}
                disabled={isDownloading}
              >
                {isDownloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
              </Button>
            </div>
          )
        })}
      </div>
    )
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
          {renderAttachmentList(interactionAttachments, 'interaction')}
        </div>
      )
    }

    // Handle main attachments (array)
    const mainAttachments = attachments.main as EvalAttachment[] | undefined
    if (mainAttachments && mainAttachments.length > 0) {
      elements.push(
        <div key="main">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">{slotLabels.main}</h4>
          {renderAttachmentList(mainAttachments, 'main')}
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
          {bonusAgent.files &&
            bonusAgent.files.length > 0 &&
            renderAttachmentList(bonusAgent.files, 'bonusAgent')}
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
          {renderAttachmentList(bonusMultimodalAttachments, 'bonusMultimodal')}
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
    const supplementaryNotesFiles = contentData.supplementaryNotesFiles as
      | EvalAttachment[]
      | undefined
    if (supplementaryNotesFiles && supplementaryNotesFiles.length > 0) {
      elements.push(
        <div key="supplementaryNotesFiles">
          <h4 className="mb-2 text-sm font-medium text-text-secondary">
            {t('answers.supplementary_notes') || 'Answer Notes'}
          </h4>
          {renderAttachmentList(supplementaryNotesFiles, 'supplementaryNotes')}
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

    if (elements.length > 0) {
      return <div className="space-y-4">{elements}</div>
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
          {renderAttachmentList(attachments, 'attachments')}
        </div>
      )
    }

    // Handle other unknown data by showing JSON
    const knownKeys = [
      'text',
      'content',
      'criteria',
      'url',
      'attachments',
      'participantName',
      'selectedTopicId',
      'supplementaryNotes',
      'supplementaryNotesFiles',
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
        description: t('actions.save') + ' ' + t('grading.report'),
      })
      setIsEditing(false)
      loadData()
    } catch (error) {
      // Check for 409 conflict error
      if (error instanceof Error && error.message.includes('modified by another user')) {
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
          description: error instanceof Error ? error.message : '',
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

  const handlePublish = async () => {
    if (!gradingTask) return

    // Check if human report exists
    const humanContent = getHumanReportContent(gradingTask.report_data)
    if (!humanContent || !humanContent.trim()) {
      toast({
        title: t('grading.publish_error') || 'Cannot Publish',
        description:
          t('grading.publish_error_no_human_report') ||
          'Please edit and save a human report before publishing.',
        variant: 'destructive',
      })
      return
    }

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
      // Upload file through backend proxy
      const uploadResponse = await graderUploadReportFile(gradingTask.id, file)

      // Publish with attachment
      await graderPublishTaskWithAttachment(gradingTask.id, {
        key: uploadResponse.key,
        filename: uploadResponse.filename,
        size: uploadResponse.file_size,
        contentType: uploadResponse.content_type,
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
                <EnhancedMarkdown source={aiContent} theme={theme === 'dark' ? 'dark' : 'light'} />
              </div>
            </div>
          </TabsContent>
        )}
      </Tabs>
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
            <>
              {/* AI Grading Status */}
              <Badge variant={getStatusBadgeVariant(gradingTask.status)}>
                {getStatusLabel(gradingTask.status, 'grading', t)}
              </Badge>

              {/* Human Report Status */}
              {(() => {
                const { hasHumanReport, isPublished } = getHumanReportStatus(
                  gradingTask.report_data
                )
                if (isPublished) {
                  return (
                    <Badge variant="success">
                      {t('grading.human_report_published') || 'Published'}
                    </Badge>
                  )
                }
                if (hasHumanReport) {
                  return (
                    <Badge variant="warning">{t('grading.human_report_draft') || 'Draft'}</Badge>
                  )
                }
                return (
                  <Badge variant="secondary">{t('grading.no_human_report') || 'No Report'}</Badge>
                )
              })()}
            </>
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
          <div className="rounded-lg bg-surface p-4">{renderContentData(answer.content_data)}</div>
        </CardContent>
      </Card>

      {/* Grading Task Card */}
      {gradingTask && (
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t('grading.report')}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                {/* AI Grading Actions - Only show when grading bot is configured */}
                {gradingTask.team_id > 0 && gradingTask.status === GradingTaskStatus.PENDING && (
                  <Button variant="outline" onClick={handleExecute} disabled={executing}>
                    <Play className="mr-2 h-4 w-4" />
                    {t('grading.execute')}
                  </Button>
                )}
                {gradingTask.team_id > 0 &&
                  (gradingTask.status === GradingTaskStatus.FAILED ||
                    gradingTask.status === GradingTaskStatus.COMPLETED) && (
                    <Button variant="outline" onClick={handleRetry} disabled={executing}>
                      <RotateCcw className="mr-2 h-4 w-4" />
                      {t('grading.retry')}
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
                  onClick={() => {
                    if (!isEditing) {
                      // Entering edit mode - initialize editedReport from current data
                      if (gradingTask?.report_data) {
                        const humanContent = getHumanReportContent(gradingTask.report_data)
                        const aiContent = getAIReportContent(gradingTask.report_data)
                        setEditedReport(humanContent || aiContent || '')
                      } else {
                        setEditedReport('')
                      }
                      // Initialize version for optimistic locking
                      setEditedReportVersion(gradingTask?.version || 1)
                    }
                    setIsEditing(!isEditing)
                  }}
                  disabled={publishing || uploading}
                >
                  <Edit className="mr-2 h-4 w-4" />
                  {isEditing ? t('actions.cancel') : t('grading.edit_report')}
                </Button>

                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  className="hidden"
                  accept=".md,.txt,.markdown"
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || isEditing}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {uploading ? '...' : t('grading.upload_report')}
                </Button>

                {gradingTask.status !== GradingTaskStatus.PUBLISHED && (
                  <Button
                    variant="primary"
                    onClick={handlePublish}
                    disabled={publishing || isEditing}
                    title={t('grading.publish_ai_as_final_hint')}
                  >
                    <CheckCircle className="mr-2 h-4 w-4" />
                    {publishing ? '...' : t('grading.publish')}
                  </Button>
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
                {gradingTask.task_id > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={() => router.push(`/chat?taskId=${gradingTask.task_id}`)}
                    title={t('grading.view_execution_task_hint')}
                  >
                    {t('grading.view_execution_task')}
                  </Button>
                )}
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
                          {t('actions.edit')}
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
                    <div className="min-h-[400px] rounded-lg border border-border bg-surface p-4">
                      {editedReport.trim() ? (
                        <div className="markdown-content">
                          <EnhancedMarkdown
                            source={editedReport}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        </div>
                      ) : (
                        <p className="text-text-muted">{t('grading.no_report_data')}</p>
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

                  <p className="text-xs text-text-muted">
                    {t(
                      'grading.markdown_hint',
                      'Supports Markdown formatting: **bold**, *italic*, `code`, lists, etc.'
                    )}
                  </p>
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIsEditing(false)}>
                    {t('actions.cancel')}
                  </Button>
                  <Button variant="primary" onClick={() => handleSaveReport()} disabled={saving}>
                    <Save className="mr-2 h-4 w-4" />
                    {saving ? '...' : t('actions.save')}
                  </Button>
                </div>
              </div>
            ) : (
              renderReportContent(gradingTask.report_data)
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
              {t('actions.cancel')}
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
