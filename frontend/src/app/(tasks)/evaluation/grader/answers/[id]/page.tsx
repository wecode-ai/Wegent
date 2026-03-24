// This is a simplified version showing just the layout structure
// The full implementation would include all the existing helper functions and logic

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
  AlertTriangle,
  RefreshCw,
  Send,
  Link,
  ArrowLeft,
  FileText,
  MessageSquare,
  ChevronUp,
  ChevronDown,
  Copy,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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
import { fetchFileContent } from '@wecode/api/evaluation-shared'
import type {
  Answer,
  Question,
  GradingTask,
  EvalAttachment,
  ChatTaskInfo,
} from '@wecode/types/evaluation'
import { GradingTaskStatus, getStatusLabel } from '@wecode/types/evaluation'
import { useGradingActions } from '@wecode/components/evaluation/grader/useGradingActions'
import { useTranslation } from '@/hooks/useTranslation'
import {
  AttachmentList,
  generateEvaluationPrefixedFilename,
} from '@wecode/components/evaluation/common'
import { ExamMarkdownContent } from '@wecode/components/evaluation/exam'
import {
  isExamQuestionContent,
  type ExamQuestionContent,
  type AnswerSlot,
} from '@wecode/types/evaluation-exam'

// Extract report content from report_data structure
const extractReportContent = (reportData: Record<string, unknown>): string => {
  if (!reportData || Object.keys(reportData).length === 0) {
    return ''
  }
  if (typeof reportData === 'string') {
    return reportData
  }
  if (typeof reportData.content === 'string') {
    return reportData.content
  }
  return ''
}

// Get AI report S3 path from report_data
const getAIReportS3Path = (reportData: Record<string, unknown>): string | null => {
  if (!reportData) return null
  const aiReport = reportData.ai_report as Record<string, unknown> | undefined
  if (aiReport && typeof aiReport.s3_path === 'string') {
    return aiReport.s3_path
  }
  return null
}

// Get human report S3 path from report_data
const getHumanReportS3Path = (reportData: Record<string, unknown>): string | null => {
  if (!reportData) return null
  const humanReport = reportData.human_report as Record<string, unknown> | undefined
  if (humanReport && typeof humanReport.s3_path === 'string') {
    return humanReport.s3_path
  }
  return null
}

// Get final report S3 path from report_data
const getFinalReportS3Path = (reportData: Record<string, unknown>): string | null => {
  if (!reportData) return null
  const finalReport = reportData.final_report as Record<string, unknown> | undefined
  if (finalReport && typeof finalReport.s3_path === 'string') {
    return finalReport.s3_path
  }
  return null
}

// Copy button component
const CopyButton = ({ content, className = '' }: { content: string; className?: string }) => {
  const [copied, setCopied] = useState(false)
  const { t } = useTranslation('evaluation')

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className={`h-8 px-2 ${className}`}
      title={t('common:actions.copy') || 'Copy'}
      disabled={!content}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-500" />
      ) : (
        <Copy className="h-4 w-4 text-gray-500" />
      )}
    </Button>
  )
}

// Collapsible section component - defined outside to prevent re-renders
const CollapsibleSection = ({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
}: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
  defaultOpen?: boolean
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50/50 transition-colors cursor-pointer"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-gray-500" />
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
        </div>
        {isOpen ? (
          <ChevronUp className="h-5 w-5 text-gray-400" />
        ) : (
          <ChevronDown className="h-5 w-5 text-gray-400" />
        )}
      </div>
      {isOpen && <div className="px-6 pb-6">{children}</div>}
    </div>
  )
}

// Get all related chat tasks from report_data
const getRelatedChatTasks = (reportData: Record<string, unknown>): ChatTaskInfo[] => {
  if (!reportData) return []
  const tasks: ChatTaskInfo[] = []
  const multiModelData = reportData.multi_model_grading as Record<string, unknown> | undefined
  if (multiModelData) {
    const scoringResults = multiModelData.scoring_results as
      | Array<Record<string, unknown>>
      | undefined
    if (scoringResults) {
      scoringResults.forEach(result => {
        const taskId = result.task_id as number
        const modelId = result.model_id as string
        const status = result.status as string
        if (taskId && taskId > 0) {
          tasks.push({ taskId, modelId: modelId || 'Unknown', type: 'scorer', status })
        }
      })
    }
    const aggregatorTaskId = multiModelData.aggregator_task_id as number | undefined
    if (aggregatorTaskId && aggregatorTaskId > 0) {
      tasks.push({ taskId: aggregatorTaskId, modelId: 'Aggregator', type: 'aggregator' })
    }
  }
  // For single model grading, task_id is stored in report_data (unified with multi-model)
  const taskId = reportData.task_id as number | undefined
  if (taskId && taskId > 0 && tasks.length === 0) {
    tasks.push({ taskId, modelId: 'AI Grading', type: 'single' })
  }
  return tasks
}

// Get AI report content
const getAIReportContent = (reportData: Record<string, unknown>): string => {
  if (!reportData) return ''
  const aiReport = reportData.ai_report as Record<string, unknown> | undefined
  if (aiReport) {
    return extractReportContent(aiReport)
  }
  if (typeof reportData.content === 'string' && reportData.content) {
    return reportData.content
  }
  if (typeof reportData.result === 'string' && reportData.result) {
    return reportData.result
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
  const [reportContents, setReportContents] = useState<{
    ai: string
    human: string
    final: string
  }>({
    ai: '',
    human: '',
    final: '',
  })
  const [publishing, setPublishing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedReport, setEditedReport] = useState('')
  const [editedReportVersion, setEditedReportVersion] = useState<number>(1)
  const [showReportPreview, setShowReportPreview] = useState(false)
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [conflictServerVersion, setConflictServerVersion] = useState<number>(1)
  const [conflictServerReport, setConflictServerReport] = useState('')
  const [pendingSaveContent, setPendingSaveContent] = useState('')
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishAttachment, setPublishAttachment] = useState<File | null>(null)
  // State for loading text content from S3 for slot answers
  const [loadedSlotTexts, setLoadedSlotTexts] = useState<Record<string, string>>({})
  const [loadingSlots, setLoadingSlots] = useState<Set<string>>(new Set())

  const { executing, retryTask } = useGradingActions({
    onSuccess: () => loadData(),
  })

  const loadData = useCallback(
    async (options?: { skipEditedReportUpdate?: boolean }) => {
      const { skipEditedReportUpdate = false } = options || {}
      setLoading(true)
      try {
        const answerData = await getGraderAnswer(answerId)
        setAnswer(answerData)
        const questionData = await getGraderQuestion(answerData.question_id)
        setQuestion(questionData)
        let taskData: GradingTask | null = null
        if (answerData.grading_task_id) {
          taskData = await getGraderTask(answerData.grading_task_id)
          setGradingTask(taskData)
        } else {
          const tasksData = await listGraderTasks({ limit: 100 })
          const task = tasksData.items.find(t => t.answer_id === answerId)
          if (task) {
            taskData = await getGraderTask(task.id)
            setGradingTask(taskData)
          }
        }
        if (taskData?.report_data) {
          try {
            let finalContent = ''
            let humanContent = ''
            let aiContent = ''

            // Always prefer S3 content (full content) over inline content (truncated)
            const finalS3Path = getFinalReportS3Path(taskData.report_data)
            if (finalS3Path) {
              finalContent = await fetchFileContent(finalS3Path)
            } else {
              finalContent = getFinalReportContent(taskData.report_data)
            }

            const humanS3Path = getHumanReportS3Path(taskData.report_data)
            if (humanS3Path) {
              humanContent = await fetchFileContent(humanS3Path)
            } else {
              humanContent = getHumanReportContent(taskData.report_data)
            }

            const aiS3Path = getAIReportS3Path(taskData.report_data)
            if (aiS3Path) {
              aiContent = await fetchFileContent(aiS3Path)
            } else {
              aiContent = getAIReportContent(taskData.report_data)
            }

            setReportContents({ final: finalContent, human: humanContent, ai: aiContent })
            if (!skipEditedReportUpdate) {
              setEditedReport(humanContent || aiContent || '')
            }
          } catch {
            if (!skipEditedReportUpdate) setEditedReport('')
          }
          setEditedReportVersion(taskData.version || 1)
        }
      } catch {
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
    if (answerId) loadData()
  }, [answerId, loadData])

  const handleRetry = async () => {
    if (!gradingTask) return
    await retryTask(gradingTask.id)
  }

  const extractErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return String(error)
  }

  const handleSaveReport = async (content?: string, version?: number) => {
    if (!gradingTask) return
    const reportContent = content ?? editedReport.trim()
    if (!reportContent) return
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
      const isConflictError = errorMessage.includes('modified by another user')
      if (isConflictError) {
        try {
          const currentTask = await getGraderTask(gradingTask.id)
          setConflictServerVersion(currentTask.version || 1)
          setConflictServerReport(
            getHumanReportContent(currentTask.report_data) ||
              getAIReportContent(currentTask.report_data) ||
              ''
          )
          setPendingSaveContent(reportContent)
          setConflictDialogOpen(true)
        } catch {
          toast({
            title: t('errors.save_failed'),
            description: 'Conflict detected',
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: t('errors.save_failed'), description: errorMessage, variant: 'destructive' })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleConflictViewServer = () => {
    setEditedReport(conflictServerReport)
    setEditedReportVersion(conflictServerVersion)
    setConflictDialogOpen(false)
  }

  const handleConflictOverwrite = async () => {
    setConflictDialogOpen(false)
    await handleSaveReport(pendingSaveContent, conflictServerVersion)
  }

  const handleConflictCancel = () => {
    setConflictDialogOpen(false)
  }

  const canPublish = (task: GradingTask): boolean => {
    const humanContent = getHumanReportContent(task.report_data)
    const hasHumanReport = !!humanContent && humanContent.trim().length > 0
    const isCompleted = task.status === GradingTaskStatus.COMPLETED
    const isPublished = task.status === GradingTaskStatus.PUBLISHED
    const isPendingOrFailed =
      task.status === GradingTaskStatus.PENDING || task.status === GradingTaskStatus.FAILED
    // Allow: COMPLETED, PUBLISHED (for republish), or PENDING/FAILED with human report
    return isCompleted || isPublished || (isPendingOrFailed && hasHumanReport)
  }

  const hasAnyReport = (task: GradingTask): boolean => {
    const aiContent = getAIReportContent(task.report_data)
    const humanContent = getHumanReportContent(task.report_data)
    return !!(aiContent?.trim() || humanContent?.trim())
  }

  const handlePublishClick = () => {
    if (!gradingTask) return
    if (!canPublish(gradingTask)) {
      toast({
        title: t('grading.publish_error') || 'Cannot Publish',
        description: t('grading.publish_error_no_report') || 'Please edit and save a report first',
        variant: 'destructive',
      })
      return
    }
    setPublishAttachment(null)
    setPublishDialogOpen(true)
  }

  const handleConfirmPublish = async () => {
    if (!gradingTask) return
    setPublishing(true)
    try {
      if (publishAttachment) {
        const uploadResponse = await graderUploadReportFile(gradingTask.id, publishAttachment)
        await graderPublishTaskWithAttachment(gradingTask.id, {
          key: uploadResponse.key,
          filename: uploadResponse.filename,
          size: uploadResponse.file_size,
          contentType: uploadResponse.content_type,
        })
      } else {
        await publishGraderTask(gradingTask.id)
      }
      toast({ title: t('grading.publish_success'), description: '' })
      setPublishDialogOpen(false)
      loadData()
    } catch {
      toast({ title: t('errors.publish_failed'), description: '', variant: 'destructive' })
    } finally {
      setPublishing(false)
    }
  }

  const getStatusBadgeVariant = (status: number) => {
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

  const getHumanReportStatus = () => {
    const humanContent = reportContents.human
    const finalContent = reportContents.final
    return {
      hasHumanReport: !!humanContent && humanContent.trim().length > 0,
      isPublished: !!finalContent && finalContent.trim().length > 0,
    }
  }

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

  const handleDownloadSuccess = (attachment: EvalAttachment) => {
    toast({
      title: t('grading.download_success'),
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

  // Load text from S3 for slot answers that have .txt files but empty text
  const loadSlotTextFromS3 = useCallback(
    async (slotKey: string, files: EvalAttachment[]) => {
      if (loadedSlotTexts[slotKey] || loadingSlots.has(slotKey)) return

      const txtFile = files.find(f => f.filename.endsWith('.txt'))
      if (!txtFile) return

      setLoadingSlots(prev => new Set(prev).add(slotKey))
      try {
        const content = await fetchFileContent(txtFile.key)
        setLoadedSlotTexts(prev => ({ ...prev, [slotKey]: content }))
      } catch (error) {
        console.error(`Failed to load text from S3 for slot ${slotKey}:`, error)
      } finally {
        setLoadingSlots(prev => {
          const newSet = new Set(prev)
          newSet.delete(slotKey)
          return newSet
        })
      }
    },
    [loadedSlotTexts, loadingSlots]
  )

  // Get answer slots from question content_data for display labels
  const answerSlots: AnswerSlot[] = isExamQuestionContent(question?.content_data)
    ? (question?.content_data as ExamQuestionContent).answerSlots || []
    : []

  // Helper to get slot label by key
  const getSlotLabel = (slotKey: string): string => {
    const slot = answerSlots.find(s => s.key === slotKey)
    return slot?.label || slotKey.replace(/([A-Z])/g, ' $1').trim()
  }

  // Render dynamic slot-based answers
  const renderSlotAnswers = (answers: Record<string, unknown> | undefined) => {
    if (!answers || Object.keys(answers).length === 0) return null
    const elements: React.ReactNode[] = []

    // Sort by answerSlots order, filter to only defined slots
    const sortedKeys = (() => {
      const slotOrder = answerSlots.map(s => s.key)
      const answersKeys = Object.keys(answers)
      // Only include keys that are defined in question's answerSlots
      const orderedKeys = slotOrder.filter(key => answersKeys.includes(key))
      return orderedKeys
    })()

    sortedKeys.forEach(slotKey => {
      const slotAnswer = answers[slotKey]
      if (!slotAnswer || typeof slotAnswer !== 'object') return
      const answer = slotAnswer as { text?: string; link?: string; files?: EvalAttachment[] }
      const slotLabel = getSlotLabel(slotKey)

      // Check if there's a .txt file (text was converted to attachment)
      const hasFiles = answer.files && answer.files.length > 0
      const hasTxtFile = hasFiles && answer.files!.some(f => f.filename.endsWith('.txt'))

      // Only show text content if there's no .txt file attachment
      // If text was converted to .txt file, just show the file as downloadable
      if (!hasTxtFile) {
        // Check if we need to load text from S3
        const hasEmptyText = !answer.text || !answer.text.trim()

        if (hasEmptyText && hasFiles && !loadedSlotTexts[slotKey] && !loadingSlots.has(slotKey)) {
          // Trigger async load for non-.txt files that might contain text
          const txtFile = answer.files!.find(f => f.filename.endsWith('.txt'))
          if (txtFile) {
            loadSlotTextFromS3(slotKey, answer.files!)
          }
        }

        // Use loaded text from S3 if original text is empty
        const displayText = answer.text?.trim() ? answer.text : loadedSlotTexts[slotKey]

        // Render text content (original or loaded from S3)
        if (displayText && displayText.trim()) {
          elements.push(
            <div key={`${slotKey}-text`} className="mb-4">
              <h4 className="mb-2 text-sm font-medium text-text-secondary">{slotLabel}</h4>
              <div className="markdown-content prose prose-sm max-w-none">
                <EnhancedMarkdown
                  source={displayText}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
            </div>
          )
        } else if (loadingSlots.has(slotKey)) {
          // Show loading indicator while fetching from S3
          elements.push(
            <div key={`${slotKey}-loading`} className="mb-4">
              <h4 className="mb-2 text-sm font-medium text-text-secondary">{slotLabel}</h4>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('slots.loading_content') || 'Loading content...'}
              </div>
            </div>
          )
        }
      }

      // Render link
      if (answer.link && answer.link.trim()) {
        elements.push(
          <div key={`${slotKey}-link`} className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-text-secondary">
              {slotLabel} - {t('slots.link') || '链接'}
            </h4>
            <a
              href={answer.link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <Link className="h-3 w-3" />
              {answer.link}
            </a>
          </div>
        )
      }

      // Render files (all files are downloadable, including .txt that was converted from text)
      if (answer.files && answer.files.length > 0) {
        elements.push(
          <div key={`${slotKey}-files`} className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-text-secondary">
              {slotLabel} - {t('questions.attachments')}
            </h4>
            <AttachmentList
              attachments={answer.files}
              generatePrefixedFilename={(attachment, index) =>
                generatePrefixedFilename(attachment, index, slotKey)
              }
              onDownloadSuccess={handleDownloadSuccess}
              onDownloadError={handleDownloadError}
            />
          </div>
        )
      }
    })

    if (elements.length === 0) return null
    return <div className="space-y-2">{elements}</div>
  }

  const renderContentData = (
    contentData: Record<string, unknown> | undefined,
    showEmpty: boolean = true
  ) => {
    if (!contentData || Object.keys(contentData).length === 0) {
      return showEmpty ? <p className="text-text-secondary">{t('answers.no_answers')}</p> : null
    }

    const elements: React.ReactNode[] = []

    // Render dynamic slot-based answers
    const answersData = contentData.answers as Record<string, unknown> | undefined
    const slotAnswers = renderSlotAnswers(answersData)
    if (slotAnswers) {
      elements.push(<div key="slotAnswers">{slotAnswers}</div>)
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

    if (elements.length === 0) {
      return showEmpty ? <p className="text-text-secondary">{t('answers.no_answers')}</p> : null
    }

    return <>{elements}</>
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafbfc]">
        <header className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center">
            <Skeleton className="h-8 w-48" />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-96 rounded-2xl" />
        </main>
      </div>
    )
  }

  if (!answer || !question) return null

  const getStatusBadge = () => {
    if (!gradingTask) return null
    const { hasHumanReport, isPublished } = getHumanReportStatus()

    // Priority: PUBLISHED > RUNNING > hasHumanReport > other statuses
    if (gradingTask.status === GradingTaskStatus.PUBLISHED || isPublished) {
      return (
        <Badge variant="success" className="text-sm px-3 py-1">
          {t('grading.status.published')}
        </Badge>
      )
    }

    // Show RUNNING status when task is being processed (even if hasHumanReport)
    if (gradingTask.status === GradingTaskStatus.RUNNING) {
      return (
        <Badge variant="info" className="text-sm px-3 py-1">
          {t('grading.status.running')}...
        </Badge>
      )
    }

    if (hasHumanReport) {
      return (
        <Badge variant="warning" className="text-sm px-3 py-1">
          {t('grading.human_report_draft') || 'Draft'}
        </Badge>
      )
    }

    return (
      <Badge variant={getStatusBadgeVariant(gradingTask.status)} className="text-sm px-3 py-1">
        {getStatusLabel(gradingTask.status, 'grading', t)}
      </Badge>
    )
  }

  const chatTasks = gradingTask ? getRelatedChatTasks(gradingTask.report_data) : []

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      {/* Clean Minimal Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/evaluation/grader')}
              className="h-8 w-8 p-0"
            >
              <ArrowLeft className="h-4 w-4 text-gray-600" />
            </Button>
            <div className="h-4 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900">{question.title}</span>
              <span className="text-sm text-gray-400">·</span>
              <span className="text-sm text-gray-500">
                {answer.respondent_name || `User #${answer.respondent_id}`}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {getStatusBadge()}
            {/* Retry button - only for AI grading */}
            {gradingTask?.grading_mode && gradingTask.grading_mode !== 'manual' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRetry}
                disabled={executing}
                className="h-8 w-8 p-0"
                title={t('grading.retry')}
              >
                <RotateCcw className={`h-4 w-4 ${executing ? 'animate-spin' : ''}`} />
              </Button>
            )}
            {/* Publish button - show when human report has content and not editing */}
            {/* Also show for PUBLISHED status to allow re-publishing */}
            {gradingTask && reportContents.human && !isEditing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePublishClick}
                disabled={publishing}
                className="h-8 w-8 p-0"
                title={
                  gradingTask.status === GradingTaskStatus.PUBLISHED
                    ? t('grading.republish') || t('grading.publish')
                    : t('grading.publish')
                }
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 space-y-6">
        {/* Question - Collapsible, compact */}
        <CollapsibleSection
          title={t('questions.question_content') || 'Question'}
          icon={FileText}
          defaultOpen={false}
        >
          <div className="pt-2">
            {isExamQuestionContent(question.content_data) ? (
              <ExamMarkdownContent
                icon={(question.content_data as ExamQuestionContent).display?.icon}
                title={question.title}
                content={(question.content_data as ExamQuestionContent).contentMarkdown}
                className="shadow-none bg-transparent"
              />
            ) : (
              <div className="rounded-xl bg-gray-50 p-4">
                {renderContentData(question.content_data, false) || (
                  <p className="text-gray-500">{t('questions.no_content')}</p>
                )}
              </div>
            )}
            {question.criteria_data && Object.keys(question.criteria_data).length > 0 && (
              <div className="mt-4 p-4 rounded-xl border border-amber-200 bg-amber-50/30">
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-800">
                  <ClipboardList className="h-4 w-4" />
                  {t('questions.criteria')}
                </h3>
                <div className="text-sm text-amber-700">
                  {renderContentData(question.criteria_data, false) || (
                    <p>{t('questions.no_criteria')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* Student Answer - Collapsible */}
        <CollapsibleSection title={t('answers.title')} icon={MessageSquare} defaultOpen={true}>
          <div className="pt-2">
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="prose prose-gray max-w-none">
                {renderContentData(answer.content_data)}
              </div>
            </div>
          </div>
        </CollapsibleSection>

        {/* Chat Tasks - Audit logs, expanded by default - only for AI grading */}
        {gradingTask?.grading_mode &&
          gradingTask.grading_mode !== 'manual' &&
          chatTasks.length > 0 && (
            <CollapsibleSection
              title={t('grading.related_grading_tasks') || 'Grading Tasks'}
              icon={Bot}
              defaultOpen={true}
            >
              <div className="pt-2 space-y-2">
                {chatTasks.map((chatTask, index) => (
                  <div
                    key={chatTask.taskId}
                    className="flex items-center justify-between p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-8 w-8 rounded flex items-center justify-center text-sm font-medium ${chatTask.type === 'aggregator' ? 'bg-purple-100 text-purple-600' : chatTask.type === 'scorer' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}
                      >
                        {chatTask.type === 'aggregator'
                          ? 'Σ'
                          : chatTask.type === 'scorer'
                            ? index + 1
                            : 'AI'}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          {chatTask.type === 'aggregator'
                            ? t('grading.aggregator_task')
                            : chatTask.type === 'scorer'
                              ? `${t('grading.scorer_task')} ${index + 1}`
                              : t('grading.single_model_task')}
                        </div>
                        <div className="text-xs text-gray-500">{chatTask.modelId}</div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => router.push(`/chat?taskId=${chatTask.taskId}`)}
                    >
                      {t('grading.view_chat')}
                    </Button>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

        {/* AI Report - As reference, collapsible - only for AI grading */}
        {gradingTask?.grading_mode &&
          gradingTask.grading_mode !== 'manual' &&
          reportContents.ai && (
            <CollapsibleSection
              title={t('grading.ai_report') || 'AI Reference'}
              icon={Bot}
              defaultOpen={!reportContents.human && !reportContents.final}
            >
              <div className="pt-2">
                <div className="rounded-xl border border-blue-200 bg-blue-50/30 p-4">
                  {reportContents.ai === 'AI grading completed (recovered)' ? (
                    <p className="text-sm text-blue-600">{t('grading.ai_recovered_message')}</p>
                  ) : (
                    <div className="markdown-content prose prose-sm max-w-none">
                      <EnhancedMarkdown
                        source={reportContents.ai}
                        theme={theme === 'dark' ? 'dark' : 'light'}
                      />
                    </div>
                  )}
                </div>
                {reportContents.ai && reportContents.ai !== 'AI grading completed (recovered)' && (
                  <div className="flex justify-end mt-2">
                    <CopyButton content={reportContents.ai} />
                  </div>
                )}
              </div>
            </CollapsibleSection>
          )}

        {/* Human Report - Editable draft (always available even after publish) */}
        {gradingTask && (
          <CollapsibleSection
            title={
              gradingTask.status === GradingTaskStatus.PUBLISHED
                ? `${t('grading.human_report')} (${t('grading.human_report_draft')})`
                : t('grading.human_report')
            }
            icon={ClipboardList}
            defaultOpen={!reportContents.final}
          >
            <div className="pt-2">
              {gradingTask.status === GradingTaskStatus.RUNNING && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3 text-sm text-blue-700">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t('grading.status.running')}...</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7"
                    onClick={() =>
                      gradingTask.task_id > 0 && router.push(`/chat?taskId=${gradingTask.task_id}`)
                    }
                  >
                    {t('grading.view_chat')}
                  </Button>
                </div>
              )}
              {isEditing ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-base font-medium">{t('grading.report_content')}</Label>
                    <div className="flex items-center gap-2">
                      <Button
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
                            {t('grading.preview')}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  {showReportPreview ? (
                    <div className="min-h-[300px] rounded-xl border border-gray-200 bg-gray-50 p-4">
                      {editedReport.trim() ? (
                        <div className="markdown-content">
                          <EnhancedMarkdown
                            source={editedReport}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        </div>
                      ) : (
                        <p className="text-gray-400 italic">{t('grading.no_report_data')}</p>
                      )}
                    </div>
                  ) : (
                    <Textarea
                      value={editedReport}
                      onChange={e => setEditedReport(e.target.value)}
                      rows={12}
                      className="font-mono text-sm resize-y"
                      placeholder={
                        t('grading.report_content_placeholder') ||
                        'Enter your grading report here...'
                      }
                    />
                  )}
                  <div className="flex items-center justify-between pt-2 border-t">
                    <p className="text-xs text-gray-400">
                      {t('grading.markdown_supported') || 'Markdown supported'}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" onClick={() => setIsEditing(false)}>
                        {t('common:actions.cancel')}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => handleSaveReport()}
                        disabled={saving}
                      >
                        <Save className="mr-2 h-4 w-4" />
                        {saving ? t('common:actions.saving') : t('common:actions.save')}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  {reportContents.human ? (
                    <div className="space-y-4">
                      <div className="rounded-xl border border-amber-200 bg-amber-50/30 p-4">
                        <div className="markdown-content prose prose-gray max-w-none">
                          <EnhancedMarkdown
                            source={reportContents.human}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <CopyButton content={reportContents.human} />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            try {
                              const freshTask = await getGraderTask(gradingTask.id)
                              setGradingTask(freshTask)
                              let humanContent = '',
                                aiContent = ''
                              if (freshTask.report_data) {
                                const humanS3Path = getHumanReportS3Path(freshTask.report_data)
                                const aiS3Path = getAIReportS3Path(freshTask.report_data)
                                if (humanS3Path) humanContent = await fetchFileContent(humanS3Path)
                                if (aiS3Path) aiContent = await fetchFileContent(aiS3Path)
                              }
                              setEditedReport(humanContent || aiContent || '')
                              setEditedReportVersion(freshTask.version || 1)
                            } catch {
                              setEditedReport(reportContents.human || reportContents.ai || '')
                              setEditedReportVersion(gradingTask?.version || 1)
                            }
                            setIsEditing(true)
                          }}
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          {t('grading.edit_report')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <ClipboardList className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                      <p className="text-gray-500 mb-4">{t('grading.no_report_data')}</p>
                      <Button
                        onClick={async () => {
                          try {
                            const freshTask = await getGraderTask(gradingTask.id)
                            setGradingTask(freshTask)
                            let humanContent = '',
                              aiContent = ''
                            if (freshTask.report_data) {
                              const humanS3Path = getHumanReportS3Path(freshTask.report_data)
                              const aiS3Path = getAIReportS3Path(freshTask.report_data)
                              if (humanS3Path) humanContent = await fetchFileContent(humanS3Path)
                              if (aiS3Path) aiContent = await fetchFileContent(aiS3Path)
                            }
                            setEditedReport(humanContent || aiContent || '')
                            setEditedReportVersion(freshTask.version || 1)
                          } catch {
                            setEditedReport(reportContents.human || reportContents.ai || '')
                            setEditedReportVersion(gradingTask?.version || 1)
                          }
                          setIsEditing(true)
                        }}
                      >
                        <Edit className="mr-2 h-4 w-4" />
                        {t('grading.start_grading')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* Final Published Report - Shown when published (at the bottom) */}
        {gradingTask?.status === GradingTaskStatus.PUBLISHED && reportContents.final && (
          <CollapsibleSection
            title={t('grading.final_report')}
            icon={CheckCircle}
            defaultOpen={!!reportContents.final}
          >
            <div className="pt-2">
              <div className="rounded-xl border border-green-200 bg-green-50/30 p-4">
                <div className="markdown-content prose prose-gray max-w-none">
                  <EnhancedMarkdown
                    source={reportContents.final}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                  />
                </div>
              </div>
              <div className="flex justify-end mt-2">
                <CopyButton content={reportContents.final} />
              </div>
            </div>
          </CollapsibleSection>
        )}
      </main>

      {/* Dialogs */}
      <Dialog open={conflictDialogOpen} onOpenChange={setConflictDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <DialogTitle>{t('grading.conflict_title') || 'Report Modified'}</DialogTitle>
            </div>
            <DialogDescription>{t('grading.conflict_description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={handleConflictCancel}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="outline" onClick={handleConflictViewServer}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('grading.conflict_load_server')}
            </Button>
            <Button variant="primary" onClick={handleConflictOverwrite}>
              <Save className="mr-2 h-4 w-4" />
              {t('grading.conflict_overwrite')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('grading.publish_dialog_title')}</DialogTitle>
            <DialogDescription>{t('grading.publish_dialog_description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => setPublishDialogOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirmPublish}
              disabled={publishing || (!hasAnyReport(gradingTask!) && !publishAttachment)}
            >
              <Send className="mr-2 h-4 w-4" />
              {publishing ? t('grading.publishing') : t('grading.confirm_publish')}
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
