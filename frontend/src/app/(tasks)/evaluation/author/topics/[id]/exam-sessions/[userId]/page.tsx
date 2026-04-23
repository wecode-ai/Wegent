// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  User,
  Clock,
  FileText,
  Paperclip,
  CheckCircle,
  Circle,
  AlertCircle,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import {
  getExamSessionDetail,
  type ExamSessionDetail,
  type ExamSessionDetailQuestion,
} from '@wecode/api/evaluation-author'
import {
  AttachmentList,
  generateEvaluationPrefixedFilename,
  type GenericAttachment,
} from '@wecode/components/evaluation/common'
import { fetchFileContent } from '@wecode/api/evaluation-shared'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'
import {
  isExamQuestionContent,
  type ExamQuestionContent,
  type AnswerSlot,
} from '@wecode/types/evaluation-exam'

interface Attachment {
  key: string
  filename: string
  size?: number
  content_type?: string
}

/** Single slot answer */
interface SlotAnswer {
  text?: string
  link?: string
  files?: Attachment[]
}

interface AnswerContent {
  participantName?: string
  selectedTopicId?: number
  /** Dynamic slot-based answers */
  answers?: Record<string, SlotAnswer>
}

const PHASE_OPTIONS = [
  { value: 'intro', label: '介绍中', color: 'blue' },
  { value: 'exam', label: '考试中', color: 'emerald' },
  { value: 'review', label: '检查中', color: 'orange' },
  { value: 'completed', label: '已完成', color: 'gray' },
]

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}小时${minutes}分钟${secs}秒`
  } else if (minutes > 0) {
    return `${minutes}分钟${secs}秒`
  } else {
    return `${secs}秒`
  }
}

function getPhaseBadge(phase: string) {
  const option = PHASE_OPTIONS.find(p => p.value === phase) || PHASE_OPTIONS[0]
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-700 border-blue-200',
    emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    orange: 'bg-orange-100 text-orange-700 border-orange-200',
    gray: 'bg-gray-100 text-gray-700 border-gray-200',
  }

  return <Badge className={`${colorClasses[option.color]} border`}>{option.label}</Badge>
}

interface AttachmentSectionProps {
  title: string
  files: Attachment[]
  userId: number
  topicId: number
  questionId: number
  slot: string
}

function AttachmentSection({
  title,
  files,
  userId,
  topicId,
  questionId,
  slot,
}: AttachmentSectionProps) {
  const { toast } = useToast()

  const handleDownloadSuccess = (file: GenericAttachment) => {
    toast({
      title: '下载成功',
      description: file.filename,
    })
  }

  const handleDownloadError = () => {
    toast({
      title: '下载失败',
      description: '无法下载文件',
      variant: 'destructive',
    })
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
        <Paperclip className="w-4 h-4" />
        {title}
      </h4>
      <AttachmentList
        attachments={files}
        generatePrefixedFilename={(file, index) =>
          generateEvaluationPrefixedFilename(file, {
            userId,
            topicId,
            questionId,
            slot,
            fileIndex: index,
          })
        }
        onDownloadSuccess={handleDownloadSuccess}
        onDownloadError={handleDownloadError}
      />
    </div>
  )
}

function QuestionAnswerCard({
  question,
  answerContent,
  userId,
  topicId,
}: {
  question: ExamSessionDetailQuestion
  answerContent?: AnswerContent
  userId: number
  topicId: number
}) {
  const { theme } = useTheme()
  const hasAnswer = !!answerContent
  // Memoize answers to prevent useEffect from running on every render
  const answers = useMemo(() => answerContent?.answers || {}, [answerContent])

  // State for loading text content from S3
  const [loadedTexts, setLoadedTexts] = useState<Record<string, string>>({})
  const [loadingSlots, setLoadingSlots] = useState<Set<string>>(new Set())

  // Load text from S3 for slots that have .txt files but empty text
  useEffect(() => {
    const loadTextFromS3 = async () => {
      for (const [slotKey, slotAnswer] of Object.entries(answers)) {
        // Check if text is empty and there's a .txt file
        if (
          (!slotAnswer.text || !slotAnswer.text.trim()) &&
          slotAnswer.files &&
          slotAnswer.files.length > 0 &&
          !loadedTexts[slotKey] &&
          !loadingSlots.has(slotKey)
        ) {
          const txtFile = slotAnswer.files.find(f => f.filename.endsWith('.txt'))
          if (txtFile) {
            setLoadingSlots(prev => new Set(prev).add(slotKey))
            try {
              const content = await fetchFileContent(txtFile.key)
              setLoadedTexts(prev => ({ ...prev, [slotKey]: content }))
            } catch (error) {
              console.error(`Failed to load text from S3 for slot ${slotKey}:`, error)
            } finally {
              setLoadingSlots(prev => {
                const newSet = new Set(prev)
                newSet.delete(slotKey)
                return newSet
              })
            }
          }
        }
      }
    }
    loadTextFromS3()
  }, [answers, loadedTexts, loadingSlots])

  // Get answer slots from question content_data for display labels
  const answerSlots: AnswerSlot[] = useMemo(() => {
    return isExamQuestionContent(question.content_data)
      ? (question.content_data as ExamQuestionContent).answerSlots || []
      : []
  }, [question.content_data])

  // Helper to get slot label by key
  const getSlotLabel = (slotKey: string): string => {
    const slot = answerSlots.find(s => s.key === slotKey)
    return slot?.label || slotKey.replace(/([A-Z])/g, ' $1').trim()
  }

  // Calculate submission checklist from required slots (consistent with ExamPage)
  const checklistItems = useMemo(() => {
    // Generate checklist from required slots (excluding bonus slots)
    const items: Array<{ label: string; done: boolean }> = []

    for (const slot of answerSlots) {
      if (slot.required && !slot.isBonus) {
        const slotAnswer = answers[slot.key]
        const loadedText = loadedTexts[slot.key]
        const hasContent = Boolean(
          (slotAnswer?.files && slotAnswer.files.length > 0) ||
          (slotAnswer?.text && slotAnswer.text.trim() !== '') ||
          (loadedText && loadedText.trim() !== '') ||
          (slotAnswer?.link && slotAnswer.link.trim() !== '')
        )
        items.push({
          label: slot.label,
          done: hasContent,
        })
      }
    }

    return items
  }, [answerSlots, answers, loadedTexts])

  // Render a single slot answer
  const renderSlotAnswer = (slotKey: string, slotAnswer: SlotAnswer) => {
    const elements: React.ReactNode[] = []
    const slotLabel = getSlotLabel(slotKey)

    // Check if there's a .txt file (text was converted to attachment)
    const hasTxtFile = slotAnswer.files?.some(f => f.filename.endsWith('.txt'))
    const isLoadingText = loadingSlots.has(slotKey)

    // Only show text content if there's no .txt file attachment
    // If text was converted to .txt file, just show the file as downloadable
    if (!hasTxtFile) {
      // Use loaded text from S3 if original text is empty
      const displayText = slotAnswer.text?.trim() ? slotAnswer.text : loadedTexts[slotKey]

      // Render text content (original or loaded from S3)
      if (displayText && displayText.trim()) {
        elements.push(
          <div key={`${slotKey}-text`}>
            <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4" />
              {slotLabel}
            </h4>
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
              <div className="prose prose-sm max-w-none markdown-content">
                <EnhancedMarkdown
                  source={displayText}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
            </div>
          </div>
        )
      } else if (isLoadingText) {
        // Show loading indicator while fetching text from S3
        elements.push(
          <div key={`${slotKey}-loading`}>
            <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4" />
              {slotLabel}
            </h4>
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 flex items-center gap-2 text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">加载内容中...</span>
            </div>
          </div>
        )
      }
    }

    // Render link
    if (slotAnswer.link && slotAnswer.link.trim()) {
      elements.push(
        <div key={`${slotKey}-link`} className="p-3 bg-gray-50 rounded-xl border border-gray-100">
          <p className="text-xs text-gray-500 mb-1">{slotLabel} - 链接</p>
          <a
            href={slotAnswer.link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:underline break-all"
          >
            {slotAnswer.link}
          </a>
        </div>
      )
    }

    // Render files - always show all files including .txt converted from text
    if (slotAnswer.files && slotAnswer.files.length > 0) {
      elements.push(
        <AttachmentSection
          key={`${slotKey}-files`}
          title={`${slotLabel} - 附件`}
          files={slotAnswer.files}
          userId={userId}
          topicId={topicId}
          questionId={question.id}
          slot={slotKey}
        />
      )
    }

    return elements.length > 0 ? <div className="space-y-3">{elements}</div> : null
  }

  return (
    <Card className="overflow-hidden border-gray-200">
      <CardContent className="p-0">
        {/* Question Header */}
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#DF2029]/10 flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-[#DF2029]" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-gray-900">{question.title}</h3>
              <p className="text-sm text-gray-500 mt-1">题目 ID: {question.id}</p>
            </div>
            {hasAnswer ? (
              <Badge className="bg-green-100 text-green-700 border-green-200">
                <CheckCircle className="w-3 h-3 mr-1" />
                已作答
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-gray-400">
                <Circle className="w-3 h-3 mr-1" />
                未作答
              </Badge>
            )}
          </div>
        </div>

        {/* Answer Content */}
        {hasAnswer && (
          <div className="p-5 space-y-6">
            {/* Submission Checklist - consistent with ExamPage */}
            {checklistItems.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3">提交检查</h4>
                <div
                  className={`grid gap-3 ${
                    checklistItems.length === 1
                      ? 'grid-cols-1'
                      : checklistItems.length === 2
                        ? 'grid-cols-2'
                        : checklistItems.length === 3
                          ? 'grid-cols-3'
                          : checklistItems.length === 4
                            ? 'grid-cols-2 sm:grid-cols-4'
                            : checklistItems.length === 5
                              ? 'grid-cols-2 sm:grid-cols-5'
                              : checklistItems.length === 6
                                ? 'grid-cols-2 sm:grid-cols-3'
                                : 'grid-cols-2 sm:grid-cols-4'
                  }`}
                >
                  {checklistItems.map((item, index) => (
                    <div
                      key={index}
                      className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium ${
                        item.done ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-400'
                      }`}
                    >
                      {item.done ? (
                        <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border-2 border-red-300 flex-shrink-0" />
                      )}
                      <span>
                        {item.label}
                        {!item.done ? ' *' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dynamic Slot Answers - sorted by answerSlots order */}
            {(() => {
              const slotOrder = answerSlots.map(s => s.key)
              const answersKeys = Object.keys(answers)
              const orderedKeys = slotOrder.filter(key => answersKeys.includes(key))
              const remainingKeys = answersKeys.filter(key => !slotOrder.includes(key)).sort()
              return [...orderedKeys, ...remainingKeys].map(slotKey => (
                <div key={slotKey}>{renderSlotAnswer(slotKey, answers[slotKey])}</div>
              ))
            })()}
          </div>
        )}

        {!hasAnswer && (
          <div className="p-8 text-center">
            <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">该考生尚未提交此题目的答案</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function ExamSessionDetailPage() {
  const router = useRouter()
  const params = useParams()
  const topicId = Number(params.id)
  const userId = Number(params.userId)
  const { toast } = useToast()

  const [detail, setDetail] = useState<ExamSessionDetail | null>(null)
  const [loading, setLoading] = useState(true)

  // Local duration counter for exam/review phases (elapsed time, not countdown)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  // Sync with server value
  useEffect(() => {
    if (detail?.session?.exam_duration_seconds !== null) {
      setElapsedSeconds(detail?.session?.exam_duration_seconds || 0)
    }
  }, [detail?.session?.exam_duration_seconds])

  // Local timer for exam and review phases - increment elapsed time
  useEffect(() => {
    if (
      !detail?.session ||
      (detail.session.current_phase !== 'exam' && detail.session.current_phase !== 'review')
    )
      return

    const interval = setInterval(() => {
      setElapsedSeconds(prev => prev + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [detail?.session.current_phase])

  const loadDetail = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getExamSessionDetail(topicId, userId)
      setDetail(data)
    } catch (_error) {
      toast({
        title: '加载失败',
        description: '无法加载考试会话详情',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [topicId, userId, toast])

  useEffect(() => {
    loadDetail()
  }, [loadDetail])

  // Parse answer content from session_all_answers or question.answer
  const getAnswerContent = (question: ExamSessionDetailQuestion): AnswerContent | undefined => {
    // First try to get from session_all_answers (exam mode)
    if (detail?.session_all_answers && question.id.toString() in detail.session_all_answers) {
      const sessionAnswer = detail.session_all_answers[question.id.toString()] as {
        content_data?: AnswerContent
      }
      if (sessionAnswer && sessionAnswer.content_data) {
        return sessionAnswer.content_data
      }
    }

    // Fall back to question.answer (regular mode)
    if (question.answer?.content_data) {
      return question.answer.content_data as AnswerContent
    }

    return undefined
  }

  return (
    <EvaluationPageLayout>
      <div className="max-w-5xl mx-auto">
        {/* Header with back button */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">考生答题详情</h1>
            <p className="text-sm text-gray-500">查看考生的答题内容和附件</p>
          </div>
        </div>

        {loading ? (
          // Loading skeleton
          <div className="space-y-4">
            <Card>
              <CardContent className="p-5">
                <Skeleton className="h-6 w-48 mb-2" />
                <Skeleton className="h-4 w-32" />
              </CardContent>
            </Card>
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <Skeleton className="h-5 w-full mb-4" />
                  <Skeleton className="h-20 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : detail ? (
          <>
            {/* Session Info Card */}
            <Card className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-100">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-sm">
                      <User className="w-6 h-6 text-blue-600" />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-gray-900">
                        {detail.session.user_name}
                      </h2>
                      {detail.session.user_email && (
                        <p className="text-sm text-gray-600">{detail.session.user_email}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {getPhaseBadge(detail.session.current_phase)}
                    {!detail.session.is_active && (
                      <Badge variant="secondary" className="text-gray-400">
                        已重置
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-blue-100 grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">开始时间</p>
                    <p className="text-sm font-medium text-gray-900">
                      {detail.session.started_at
                        ? new Date(detail.session.started_at).toLocaleString('zh-CN')
                        : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">考试用时</p>
                    <p className="text-sm font-medium text-gray-900 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {/* For exam/review: show live elapsed time; for completed: show server value */}
                      {detail.session.current_phase === 'exam' ||
                      detail.session.current_phase === 'review'
                        ? elapsedSeconds > 0
                          ? formatDuration(elapsedSeconds)
                          : '-'
                        : detail.session.exam_duration_seconds !== null
                          ? formatDuration(detail.session.exam_duration_seconds)
                          : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">已选题目</p>
                    <p className="text-sm font-medium text-gray-900">
                      {detail.session.selected_question_id
                        ? `题目 ${detail.session.selected_question_id}`
                        : '未选择'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">当前状态</p>
                    <p className="text-sm font-medium text-gray-900">
                      {detail.session.is_overtime ? (
                        <span className="text-orange-600">已超时</span>
                      ) : (
                        <span className="text-emerald-600">正常</span>
                      )}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Topic Info */}
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">{detail.topic.name}</h2>
              {detail.topic.description && (
                <p className="text-sm text-gray-600">{detail.topic.description}</p>
              )}
            </div>

            {/* Questions and Answers */}
            <div className="space-y-4">
              <h3 className="text-base font-medium text-gray-700 flex items-center gap-2">
                <FileText className="w-4 h-4" />
                答题内容
              </h3>
              {detail.questions.map(question => (
                <QuestionAnswerCard
                  key={question.id}
                  question={question}
                  answerContent={getAnswerContent(question)}
                  userId={userId}
                  topicId={topicId}
                />
              ))}
            </div>
          </>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">无法加载考试会话详情</p>
              <Button onClick={loadDetail} className="mt-4">
                重试
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </EvaluationPageLayout>
  )
}
